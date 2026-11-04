import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PaypalError, paypalFromEnv, type PaypalClient } from "../apps/web/src/lib/paypal";
import { waitForAuthorization } from "./lib/hold-approval";

// `npm run hold:check`, which you run yourself: milestone holds against the real PayPal SANDBOX, using
// the app's own PayPal client. The sandbox can't authorize without a buyer, so it prints links for you
// to approve with a sandbox buyer. It touches no database, and emails nobody.
//
// `npm run hold:check` runs capture and void, and shows PayPal's answer to an early reauthorization.
// `npm run hold:check -- keep` leaves one authorization open, for the real reauthorize four days on.
// `npm run hold:check -- reauthorize <authorization id>` then reauthorizes and captures it.

const WAIT_MS = 10 * 60 * 1000;
const POLL_MS = 5000;
const AMOUNT_CENTS = 500;
const CURRENCY = "USD";

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

let failures = 0;

const check = (passed: boolean, what: string): void => {
  say(`${passed ? "PASS" : "FAIL"}: ${what}`);
  if (!passed) failures += 1;
};

const describeError = (error: unknown): string =>
  error instanceof PaypalError
    ? `${String(error.status)} ${error.issue ?? "no issue code"}`
    : String(error);

/** A new order, approved by you with a sandbox buyer, then authorized. */
const authorizedOrder = async (paypal: PaypalClient, label: string): Promise<string> => {
  const order = await paypal.createHoldOrder({
    requestId: randomUUID(),
    amountCents: AMOUNT_CENTS,
    currency: CURRENCY,
    description: `Sandbox hold check: ${label}`,
  });
  say(
    `\n${label}: open this, sign in with a sandbox buyer, and approve it:\n${order.approvalLink}`,
  );
  const authorizationId = await waitForAuthorization(paypal, order.id, {
    requestId: randomUUID(),
    attempts: WAIT_MS / POLL_MS,
    pause: () => sleep(POLL_MS),
  });
  if (!authorizationId) {
    throw new Error(
      `Nobody approved ${label} within 10 minutes. Run this again when you're ready.`,
    );
  }
  const held = await paypal.getAuthorization(authorizationId);
  check(held.status === "CREATED", `${label}: authorized after the buyer approved`);
  return authorizationId;
};

const captureAndConfirm = async (paypal: PaypalClient, authorizationId: string): Promise<void> => {
  const capture = await paypal.captureAuthorization(authorizationId, {
    requestId: randomUUID(),
    invoiceNumber: `HOLD-CHECK-${randomUUID().slice(0, 8)}`,
  });
  check(
    ["COMPLETED", "PENDING"].includes(capture.status),
    `capture: PayPal says ${capture.status}`,
  );
  check(
    (await paypal.getCapture(capture.id)).status === capture.status,
    "capture: PayPal's own copy agrees",
  );
};

const run = async (paypal: PaypalClient): Promise<void> => {
  const first = await authorizedOrder(paypal, "Order 1 of 2 (capture)");
  const early = await paypal
    .reauthorize(first, { requestId: randomUUID(), amountCents: AMOUNT_CENTS, currency: CURRENCY })
    .then(
      ({ authorizationId }) => ({ ok: true as const, authorizationId }),
      (error: unknown) => ({ ok: false as const, answer: describeError(error) }),
    );
  if (early.ok) {
    say(`NOTE: PayPal allowed an early reauthorization, so capturing the new one.`);
    await captureAndConfirm(paypal, early.authorizationId);
  } else {
    say(`NOTE: PayPal's answer to reauthorizing inside 3 days: ${early.answer}`);
    await captureAndConfirm(paypal, first);
  }

  const second = await authorizedOrder(paypal, "Order 2 of 2 (void)");
  await paypal.voidAuthorization(second);
  check((await paypal.getAuthorization(second)).status === "VOIDED", "void: PayPal says VOIDED");
};

const keep = async (paypal: PaypalClient): Promise<void> => {
  const id = await authorizedOrder(paypal, "Order to keep (reauthorize)");
  say(`\nKept open. In 4 to 29 days, run:\nnpm run hold:check -- reauthorize ${id}`);
};

const reauthorize = async (paypal: PaypalClient, id: string): Promise<void> => {
  const { authorizationId } = await paypal.reauthorize(id, {
    requestId: randomUUID(),
    amountCents: AMOUNT_CENTS,
    currency: CURRENCY,
  });
  check(authorizationId !== id, "reauthorize: PayPal gave a new authorization");
  await captureAndConfirm(paypal, authorizationId);
};

const main = async (): Promise<void> => {
  const [command = "run", argument] = process.argv.slice(2);
  const paypal = paypalFromEnv();
  if (command === "run") await run(paypal);
  else if (command === "keep") await keep(paypal);
  else if (command === "reauthorize" && argument) await reauthorize(paypal, argument);
  else throw new Error("Use: npm run hold:check, or -- keep, or -- reauthorize <authorization id>");
  say(failures === 0 ? "\nAll checks passed." : `\n${String(failures)} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
};

main().catch((error: unknown) => {
  process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
