import { describe, expect, it } from "vitest";
import {
  TEST_CLIENT_NAME,
  firstAllowlisted,
  maskAddress,
  setUpLiveTest,
  type ApiCall,
} from "../scripts/lib/gmail-test-setup";

// `npm run gmail:test`: what it asks the app to create. The real checks are in the app's routes,
// which have their own tests, so this covers the order, the amounts and the refusals.

const ADDRESS = "second.inbox@example.test";
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const MILESTONE_ID = "33333333-3333-4333-8333-333333333333";
const LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-TEST";

type Recorded = { method: string; path: string; body: unknown };

const fakeApp = (existing: string[] = []) => {
  const calls: Recorded[] = [];
  const answers: Record<string, unknown> = {
    "GET /api/clients": { clients: existing.map((name) => ({ name })) },
    "POST /api/clients": { client: { id: CLIENT_ID } },
    "POST /api/projects": { project: { id: PROJECT_ID } },
    [`PUT /api/projects/${PROJECT_ID}/milestones`]: { milestones: [{ id: MILESTONE_ID }] },
    [`PATCH /api/milestones/${MILESTONE_ID}`]: {},
    [`POST /api/milestones/${MILESTONE_ID}/invoice`]: {
      invoices: [{ invoiceNumber: "INV-1", amountCents: 500, currency: "USD", link: LINK }],
    },
  };
  const api: ApiCall = (method, path, body) => {
    calls.push({ method, path, body });
    return Promise.resolve(answers[`${method} ${path}`]);
  };
  return { api, calls };
};

const bodyOf = (calls: Recorded[], method: string, path: string): unknown =>
  calls.find((call) => call.method === method && call.path === path)?.body;

describe("firstAllowlisted", () => {
  it("takes the first address", () => {
    expect(firstAllowlisted(new Set([ADDRESS, "other@example.test"]))).toBe(ADDRESS);
  });

  it("refuses an empty allowlist and says what to do", () => {
    expect(() => firstAllowlisted(new Set())).toThrow(/DEV_EMAIL_ALLOWLIST is empty/);
  });
});

describe("maskAddress", () => {
  it("hides most of the address", () => {
    expect(maskAddress(ADDRESS)).toBe("se***@example.test");
  });
});

describe("setUpLiveTest", () => {
  it("creates a USD 5.00 invoice for a client on the allowlisted address", async () => {
    const { api, calls } = fakeApp();
    const result = await setUpLiveTest(api, ADDRESS, "2026-11-04");

    expect(result).toEqual({
      invoiceNumber: "INV-1",
      amountCents: 500,
      currency: "USD",
      link: LINK,
    });
    expect(bodyOf(calls, "POST", "/api/clients")).toMatchObject({
      name: TEST_CLIENT_NAME,
      email: ADDRESS,
    });
    expect(bodyOf(calls, "POST", "/api/projects")).toMatchObject({
      clientId: CLIENT_ID,
      totalCents: 500,
      currency: "USD",
      settings: { paymentTerms: { kind: "on_receipt" } },
    });
  });

  it("delivers the milestone before invoicing it, as pay-on-invoice requires", async () => {
    const { api, calls } = fakeApp();
    await setUpLiveTest(api, ADDRESS, "2026-11-04");

    const steps = calls
      .filter((call) => call.path.startsWith("/api/milestones/"))
      .map((call) => (call.method === "PATCH" ? call.body : call.method));
    expect(steps).toEqual([{ status: "in_progress" }, { status: "delivered" }, "POST"]);
  });

  it("refuses to run twice, so a repeat never makes a second PayPal invoice", async () => {
    const { api, calls } = fakeApp([TEST_CLIENT_NAME]);
    await expect(setUpLiveTest(api, ADDRESS, "2026-11-04")).rejects.toThrow(/already exists/);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });
});
