import { z } from "zod";
import type { Db } from "./db";
import {
  applyCaptureStatus,
  applyVoidedInPaypal,
  authorizeIfApproved,
  SELECT_HOLD,
  type HoldEventDeps,
  type HoldRow,
} from "./hold-flow";
import type { PaypalClient } from "./paypal";

// Server-only: verified PayPal events about a milestone hold (paypal-webhook.ts checks the signature
// first). An event only says which order, authorization or capture to look at: its state is read
// from PayPal. A failure here answers 5xx, so PayPal delivers it again, and every step can repeat.

type RawEvent = { id: string; event_type: string; resource: unknown };

const idResource = z.object({ id: z.string().min(1) });
const captureResource = z.object({
  id: z.string().min(1),
  supplementary_data: z
    .object({ related_ids: z.object({ authorization_id: z.string() }).partial() })
    .optional(),
});

const CAPTURE_EVENTS = new Set([
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.PENDING",
]);

type Lookup = { column: "paypal_order_id" | "authorization_id" | "capture_id"; value: string };

/** The columns come from this fixed list, never from the request. */
const lookupsFor = (event: RawEvent): Lookup[] => {
  if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
    const order = idResource.safeParse(event.resource);
    return order.success ? [{ column: "paypal_order_id", value: order.data.id }] : [];
  }
  if (event.event_type === "PAYMENT.AUTHORIZATION.VOIDED") {
    const authorization = idResource.safeParse(event.resource);
    return authorization.success
      ? [{ column: "authorization_id", value: authorization.data.id }]
      : [];
  }
  if (CAPTURE_EVENTS.has(event.event_type)) {
    const capture = captureResource.safeParse(event.resource);
    if (!capture.success) return [];
    const authorizationId = capture.data.supplementary_data?.related_ids.authorization_id;
    return [
      { column: "capture_id", value: capture.data.id },
      ...(authorizationId
        ? ([{ column: "authorization_id", value: authorizationId }] as const)
        : []),
    ];
  }
  return [];
};

const findHold = async (db: Db, lookups: Lookup[]): Promise<HoldRow | undefined> => {
  for (const { column, value } of lookups) {
    const { rows } = await db.query<HoldRow>(`${SELECT_HOLD} WHERE h.${column} = $1`, [value]);
    if (rows[0]) return rows[0];
  }
  return undefined;
};

const record = (db: Db, hold: HoldRow, event: RawEvent) =>
  db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ($1, 'hold', $2, 'paypal.webhook', $3)
     ON CONFLICT ((payload ->> 'paypalEventId')) WHERE payload ->> 'paypalEventId' IS NOT NULL
     DO NOTHING`,
    [
      hold.user_id,
      hold.id,
      JSON.stringify({ paypalEventId: event.id, eventType: event.event_type }),
    ],
  );

const applyToHold = async (
  deps: HoldEventDeps,
  paypal: PaypalClient,
  hold: HoldRow,
  event: RawEvent,
): Promise<boolean> => {
  if (event.event_type === "CHECKOUT.ORDER.APPROVED") return authorizeIfApproved(deps, hold);
  if (event.event_type === "PAYMENT.AUTHORIZATION.VOIDED") {
    if (!hold.authorization_id) return false;
    const remote = await paypal.getAuthorization(hold.authorization_id);
    return remote.status === "VOIDED" ? applyVoidedInPaypal(deps, hold) : false;
  }
  const capture = captureResource.parse(event.resource);
  const remote = await paypal.getCapture(capture.id);
  const before = hold.status;
  await applyCaptureStatus(deps, hold, capture.id, remote.status);
  return before !== "captured";
};

export type HoldOutcome = "ignored" | "unchanged" | "applied";

/** Undefined: this isn't about a hold, so the event belongs to someone else. */
export const applyHoldEvent = async (
  deps: HoldEventDeps,
  paypal: PaypalClient,
  event: RawEvent,
): Promise<HoldOutcome | undefined> => {
  const lookups = lookupsFor(event);
  if (lookups.length === 0) return undefined;
  const hold = await deps.runAsService((db) => findHold(db, lookups));
  if (!hold) return CAPTURE_EVENTS.has(event.event_type) ? undefined : "ignored";
  const changed = await applyToHold(deps, paypal, hold, event);
  await deps.runAsService((db) => record(db, hold, event));
  return changed ? "applied" : "unchanged";
};
