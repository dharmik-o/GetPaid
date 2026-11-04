import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeOnceApproved, createPaypalClient, type PaypalClient } from "@/lib/paypal";
import { waitForAuthorization } from "../scripts/lib/hold-approval";
import { createFakePaypal, type FakePaypal } from "./mocks/paypal";

// Whether a hold order can be authorized yet, and `npm run hold:check` waiting for that. PayPal is
// mocked by msw, and starts a hold order at PAYER_ACTION_REQUIRED as the real sandbox does.

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const stubClient = (status: string, authorizationId: string | null) => {
  const authorizeOrder = vi.fn<PaypalClient["authorizeOrder"]>(() =>
    Promise.resolve({ authorizationId: "AUTH-NEW" }),
  );
  const getOrder = vi.fn<PaypalClient["getOrder"]>(() =>
    Promise.resolve({ status, authorizationId }),
  );
  return { getOrder, authorizeOrder };
};

describe("authorizeOnceApproved", () => {
  it("authorizes an APPROVED order, keyed by the request id", async () => {
    const client = stubClient("APPROVED", null);
    expect(await authorizeOnceApproved(client, "ORDER-1", REQUEST_ID)).toBe("AUTH-NEW");
    expect(client.authorizeOrder).toHaveBeenCalledWith("ORDER-1", REQUEST_ID);
  });

  it.each(["CREATED", "PAYER_ACTION_REQUIRED", "SAVED", "VOIDED", "COMPLETED"])(
    "waits on %s with no authorization, and doesn't call authorize",
    async (status) => {
      const client = stubClient(status, null);
      expect(await authorizeOnceApproved(client, "ORDER-1", REQUEST_ID)).toBeNull();
      expect(client.authorizeOrder).not.toHaveBeenCalled();
    },
  );

  it.each(["APPROVED", "COMPLETED"])(
    "uses the authorization a %s order already has",
    async (status) => {
      const client = stubClient(status, "AUTH-OLD");
      expect(await authorizeOnceApproved(client, "ORDER-1", REQUEST_ID)).toBe("AUTH-OLD");
      expect(client.authorizeOrder).not.toHaveBeenCalled();
    },
  );
});

describe("waitForAuthorization", () => {
  const server = setupServer();
  const paypal = createPaypalClient({ clientId: "id", clientSecret: "secret" });
  let fake: FakePaypal;

  beforeAll(() => {
    server.listen({ onUnhandledFrame: "error" });
  });
  beforeEach(() => {
    fake = createFakePaypal();
    server.resetHandlers(...fake.handlers);
  });
  afterAll(() => {
    server.close();
  });

  const newOrder = () =>
    paypal.createHoldOrder({
      requestId: REQUEST_ID,
      amountCents: 500,
      currency: "USD",
      description: "Hold check",
    });

  const authorizeCalls = () => fake.calls.filter((call) => call.path.endsWith("/authorize"));

  it("polls until the buyer approves, then authorizes once", async () => {
    const order = await newOrder();
    expect(fake.orders.get(order.id)?.status).toBe("PAYER_ACTION_REQUIRED");
    const pause = vi.fn(() => {
      expect(authorizeCalls()).toEqual([]);
      fake.approveOrder(order.id);
      return Promise.resolve();
    });
    const id = await waitForAuthorization(paypal, order.id, {
      requestId: REQUEST_ID,
      attempts: 5,
      pause,
    });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(fake.authorizations.has(id ?? "")).toBe(true);
    expect(authorizeCalls()).toHaveLength(1);
  });

  it("gives up with nothing, never authorizing, if nobody approves", async () => {
    const order = await newOrder();
    const pause = vi.fn(() => Promise.resolve());
    const id = await waitForAuthorization(paypal, order.id, {
      requestId: REQUEST_ID,
      attempts: 3,
      pause,
    });
    expect(id).toBeNull();
    expect(pause).toHaveBeenCalledTimes(3);
    expect(authorizeCalls()).toEqual([]);
  });
});
