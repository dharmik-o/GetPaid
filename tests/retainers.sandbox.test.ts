import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { paypalFromEnv } from "@/lib/paypal";

// Auto-pay against the real PayPal SANDBOX (`npm run test:paypal:sandbox`): product, plan and a
// subscription waiting for approval. Nobody is emailed, and nobody can be charged without opening
// the approval link and signing in with a sandbox buyer.

const paypal = paypalFromEnv();

describe("PayPal Subscriptions in the sandbox", () => {
  it("creates a product, plan and subscription, and a retry with the same id gives the same plan", async () => {
    const product = await paypal.createProduct({
      requestId: randomUUID(),
      name: "Sandbox check: monthly hosting",
    });
    const planDraft = {
      requestId: randomUUID(),
      productId: product.id,
      name: "Sandbox check: monthly hosting",
      amountCents: 1234,
      currency: "USD",
      unit: "month" as const,
      count: 1,
      totalCycles: 0,
    };
    const plan = await paypal.createPlan(planDraft);
    expect(plan.id).toMatch(/^P-/);
    expect((await paypal.createPlan(planDraft)).id).toBe(plan.id);

    const subscription = await paypal.createSubscription({
      requestId: randomUUID(),
      planId: plan.id,
      startTime: null,
      subscriberEmail: "sandbox-subscriber@example.com",
      customId: randomUUID(),
    });
    expect(subscription.id).toMatch(/^I-/);
    expect(subscription.approvalLink).toContain("sandbox.paypal.com");

    const read = await paypal.getSubscription(subscription.id);
    expect(read.status).toBe("APPROVAL_PENDING");
    expect(read.outstandingCents).toBe(0);
  });

  it("refuses to suspend or reactivate a subscription nobody has approved", async () => {
    const product = await paypal.createProduct({
      requestId: randomUUID(),
      name: "Sandbox check: suspend",
    });
    const plan = await paypal.createPlan({
      requestId: randomUUID(),
      productId: product.id,
      name: "Sandbox check: suspend",
      amountCents: 1000,
      currency: "USD",
      unit: "month",
      count: 1,
      totalCycles: 0,
    });
    const { id } = await paypal.createSubscription({
      requestId: randomUUID(),
      planId: plan.id,
      startTime: null,
      subscriberEmail: "sandbox-subscriber@example.com",
      customId: randomUUID(),
    });
    // Activate answers that the buyer hasn't agreed, which proves its path. Suspend answers 404 here,
    // as cancel does: PayPal treats an unapproved subscription as not found for both. Suspend's path
    // is only proven once a sandbox buyer has approved a subscription.
    await expect(paypal.activateSubscription(id, "Sandbox check")).rejects.toMatchObject({
      status: 422,
      issue: "SESSION_STATE_NOT_VALID",
    });
    await expect(paypal.suspendSubscription(id, "Sandbox check")).rejects.toMatchObject({
      status: 404,
      issue: "INVALID_RESOURCE_ID",
    });
    expect((await paypal.getSubscription(id)).status).toBe("APPROVAL_PENDING");
  });

  it("creates a plan with a fixed number of weekly charges, with no decimals in JPY", async () => {
    const product = await paypal.createProduct({
      requestId: randomUUID(),
      name: "Sandbox check: fortnightly",
    });
    const plan = await paypal.createPlan({
      requestId: randomUUID(),
      productId: product.id,
      name: "Sandbox check: fortnightly",
      amountCents: 1500,
      currency: "JPY",
      unit: "week",
      count: 2,
      totalCycles: 6,
    });
    expect(plan.id).toMatch(/^P-/);
  });
});
