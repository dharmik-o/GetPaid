import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { paypalFromEnv } from "@/lib/paypal";

// Milestone holds against the real PayPal SANDBOX (`npm run test:paypal:sandbox`): everything that can
// run with no buyer. Authorizing needs a sandbox buyer to approve, and this sandbox account refuses the
// buyer-free card route, so real capture, reauthorize and void run with `npm run hold:check`.

const paypal = paypalFromEnv();

const newOrder = () =>
  paypal.createHoldOrder({
    requestId: randomUUID(),
    amountCents: 1234,
    currency: "USD",
    description: "Sandbox check: Build",
  });

describe("holds in the sandbox", () => {
  it("creates an AUTHORIZE order with an approval link on the sandbox", async () => {
    const order = await newOrder();
    expect(order.id).toBeTruthy();
    expect(new URL(order.approvalLink).host).toBe("www.sandbox.paypal.com");
    expect(await paypal.getOrder(order.id)).toMatchObject({ authorizationId: null });
  });

  it("a repeated request id returns the same order", async () => {
    const requestId = randomUUID();
    const draft = { requestId, amountCents: 1234, currency: "USD", description: "Sandbox check" };
    const first = await paypal.createHoldOrder(draft);
    const second = await paypal.createHoldOrder(draft);
    expect(second.id).toBe(first.id);
  });

  it("refuses to authorize an order the buyer hasn't approved", async () => {
    const order = await newOrder();
    await expect(paypal.authorizeOrder(order.id, randomUUID())).rejects.toMatchObject({
      status: 422,
    });
  });

  it("works with a currency that has no decimals", async () => {
    const order = await paypal.createHoldOrder({
      requestId: randomUUID(),
      amountCents: 1500,
      currency: "JPY",
      description: "Sandbox check: JPY",
    });
    expect(order.id).toBeTruthy();
  });

  it.each([
    [
      "capture",
      () =>
        paypal.captureAuthorization("0AA00000AA000000A", {
          requestId: randomUUID(),
          invoiceNumber: "SANDBOX-CHECK",
        }),
    ],
    [
      "reauthorize",
      () =>
        paypal.reauthorize("0AA00000AA000000A", {
          requestId: randomUUID(),
          amountCents: 1234,
          currency: "USD",
        }),
    ],
    ["void", () => paypal.voidAuthorization("0AA00000AA000000A")],
  ])("%s reaches PayPal's authorizations API, which doesn't know this id", async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ status: 404 });
  });
});
