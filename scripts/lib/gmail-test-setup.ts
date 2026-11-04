import { z } from "zod";

// The data for a live Gmail check: a client on an allowlisted address and one small sandbox
// invoice, made through the app's own API so every normal check and the real PayPal call run.

export const TEST_CLIENT_NAME = "Live Gmail Test";

const AMOUNT_CENTS = 500;
const CURRENCY = "USD";
const MILESTONE_DAYS_AHEAD = 7;

/** Always open, so an approval goes out whenever it's tapped. This client only. */
const OPEN_ALL_DAY = { days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "23:59" };

export type ApiCall = (method: string, path: string, body?: unknown) => Promise<unknown>;

const clientsSchema = z.object({ clients: z.array(z.object({ name: z.string() })) });
const createdClientSchema = z.object({ client: z.object({ id: z.string() }) });
const createdProjectSchema = z.object({ project: z.object({ id: z.string() }) });
const planSchema = z.object({ milestones: z.tuple([z.object({ id: z.string() })]) });
const invoicedSchema = z.object({
  invoices: z.tuple([
    z.object({
      invoiceNumber: z.string(),
      amountCents: z.int(),
      currency: z.string(),
      link: z.url(),
    }),
  ]),
});

export type LiveTestInvoice = z.infer<typeof invoicedSchema>["invoices"][0];

export const firstAllowlisted = (allowlist: ReadonlySet<string>): string => {
  const [first] = allowlist;
  if (!first) {
    throw new Error(
      "DEV_EMAIL_ALLOWLIST is empty, so nothing can send. Add your second inbox to your local env file, restart the dev server, then run this again.",
    );
  }
  return first;
};

/** Enough to recognise your own address in a log, without printing it. */
export const maskAddress = (address: string): string => {
  const [name = "", domain = ""] = address.split("@");
  return `${name.slice(0, 2)}***@${domain}`;
};

const addDays = (isoDate: string, days: number): string =>
  new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const setUpLiveTest = async (
  api: ApiCall,
  email: string,
  today: string,
): Promise<LiveTestInvoice> => {
  const { clients } = clientsSchema.parse(await api("GET", "/api/clients"));
  if (clients.some((client) => client.name === TEST_CLIENT_NAME)) {
    throw new Error(
      `A client named "${TEST_CLIENT_NAME}" already exists. Delete it under Clients first, then run this again.`,
    );
  }
  const { client } = createdClientSchema.parse(
    await api("POST", "/api/clients", {
      name: TEST_CLIENT_NAME,
      email,
      country: "GB",
      timeZone: "Europe/London",
      settings: { sendWindow: OPEN_ALL_DAY },
    }),
  );
  const deadline = addDays(today, MILESTONE_DAYS_AHEAD);
  const { project } = createdProjectSchema.parse(
    await api("POST", "/api/projects", {
      clientId: client.id,
      title: "Live Gmail test",
      totalCents: AMOUNT_CENTS,
      currency: CURRENCY,
      deadline,
      // Due today, so the scheduler plans the courtesy reminder straight away.
      settings: { paymentTerms: { kind: "on_receipt" } },
    }),
  );
  const { milestones } = planSchema.parse(
    await api("PUT", `/api/projects/${project.id}/milestones`, {
      milestones: [{ name: "Live test milestone", amountCents: AMOUNT_CENTS, deadline }],
    }),
  );
  const milestonePath = `/api/milestones/${milestones[0].id}`;
  await api("PATCH", milestonePath, { status: "in_progress" });
  await api("PATCH", milestonePath, { status: "delivered" });
  const { invoices } = invoicedSchema.parse(await api("POST", `${milestonePath}/invoice`, {}));
  return invoices[0];
};
