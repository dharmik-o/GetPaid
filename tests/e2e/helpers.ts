import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_URL, FAKE_URL, INTERNAL_TOKEN, TELEGRAM_CHAT_ID } from "./env";
import { VALID_SIGNATURE } from "../mocks/paypal";

// What the outside world does during the demo. n8n isn't running here: the test makes the calls it
// would make, to the same internal routes, with the same token.

const internal = { authorization: `Bearer ${INTERNAL_TOKEN}` };

const ok = async <T>(what: string, response: Awaited<ReturnType<APIRequestContext["post"]>>) => {
  expect(response.ok(), `${what}: ${String(response.status())} ${await response.text()}`).toBe(
    true,
  );
  return (await response.json()) as T;
};

export type TelegramOp = {
  op: string;
  reminderId?: string;
  text?: string;
  data?: { approve: string; edit: string; skip: string };
  chatId?: number;
  messageId?: number;
  primaryData?: string;
};

export type FakeState = {
  invoices: { id: string; number: string; status: string }[];
  sent: { threadId: string; to: string; subject: string; text: string }[];
  modelCalls: { model: string; kind: string }[];
};

export const fakeState = async (request: APIRequestContext): Promise<FakeState> =>
  ok<FakeState>("Read the fake services", await request.post(`${FAKE_URL}/__control/state`));

export const runScheduler = async (request: APIRequestContext) =>
  ok<{ planned: number; drafted: number }>(
    "Run the scheduler",
    await request.post(`${APP_URL}/api/internal/scheduler/run`, { headers: internal }),
  );

export const runSender = async (request: APIRequestContext) =>
  ok<{ sent: number }>(
    "Run the sender",
    await request.post(`${APP_URL}/api/internal/sender/run`, { headers: internal }),
  );

export const runReplies = async (request: APIRequestContext) =>
  ok<{ replies: number }>(
    "Run the reply listener",
    await request.post(`${APP_URL}/api/internal/replies/run`, { headers: internal }),
  );

export const telegramPending = async (request: APIRequestContext): Promise<TelegramOp[]> =>
  (
    await ok<{ ops: TelegramOp[] }>(
      "Read Telegram's cards",
      await request.post(`${APP_URL}/api/internal/telegram/pending`, { headers: internal }),
    )
  ).ops;

export const telegramDelivered = async (
  request: APIRequestContext,
  reminderId: string,
  messageId: number,
) =>
  ok<object>(
    "Record a delivered card",
    await request.post(`${APP_URL}/api/internal/telegram/delivered`, {
      headers: internal,
      data: { reminderId, messageId },
    }),
  );

let nextUpdate = 1000;

const telegramUpdate = async (request: APIRequestContext, data: object) =>
  (
    await ok<{ ops: TelegramOp[] }>(
      "Send a Telegram update",
      await request.post(`${APP_URL}/api/internal/telegram/update`, {
        headers: internal,
        data: { update_id: (nextUpdate += 1), ...data },
      }),
    )
  ).ops;

export const telegramTap = (request: APIRequestContext, data: string, messageId: number) =>
  telegramUpdate(request, {
    callback_query: {
      id: `tap-${String(messageId)}`,
      from: { id: TELEGRAM_CHAT_ID },
      data,
      message: { message_id: messageId, chat: { id: TELEGRAM_CHAT_ID, type: "private" } },
    },
  });

export const telegramSay = (request: APIRequestContext, text: string) =>
  telegramUpdate(request, {
    message: { message_id: 9, chat: { id: TELEGRAM_CHAT_ID, type: "private" }, text },
  });

/** PayPal's webhook for a paid invoice, signed so the fake's verify call accepts it. */
export const payInvoice = async (
  request: APIRequestContext,
  invoice: { id: string; value: string },
) => {
  await ok<object>(
    "Pay in the fake PayPal",
    await request.post(`${FAKE_URL}/__control/pay`, {
      data: { paypalInvoiceId: invoice.id, value: invoice.value },
    }),
  );
  return ok<{ outcome: string }>(
    "Deliver the PayPal webhook",
    await request.post(`${APP_URL}/api/webhooks/paypal`, {
      headers: {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fake",
        "paypal-transmission-id": `tx-${invoice.id}`,
        "paypal-transmission-sig": VALID_SIGNATURE,
        "paypal-transmission-time": new Date().toISOString(),
      },
      data: {
        id: `WH-${invoice.id}`,
        event_type: "INVOICING.INVOICE.PAID",
        resource: { id: invoice.id },
      },
    }),
  );
};

export const clientReplies = async (
  request: APIRequestContext,
  reply: { threadId: string; from: string; text: string },
) =>
  ok<object>(
    "Add the client's reply",
    await request.post(`${FAKE_URL}/__control/reply`, { data: reply }),
  );

/** Moves the demo clock the way a presenter does: in Settings. */
export const setClock = async (page: Page, days: number) => {
  await page.goto("/settings", { waitUntil: "networkidle" });
  await page.getByLabel("Days ahead").fill(String(days));
  await page.getByRole("button", { name: "Set the clock" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Demo clock" })).toContainText(
    `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(days)} days ahead`,
  );
};
