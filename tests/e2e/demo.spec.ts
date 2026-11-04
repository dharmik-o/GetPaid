import { expect, test, type Page } from "@playwright/test";
import { CLIENT_EMAIL, offsetDaysTo, startOfRun } from "./env";
import {
  clientReplies,
  fakeState,
  payInvoice,
  runReplies,
  runScheduler,
  runSender,
  setClock,
  telegramDelivered,
  telegramPending,
  telegramSay,
  telegramTap,
} from "./helpers";

// The 8 steps of the spec's demo plan (docs/DEMO.md is the presenter's version), against a real
// Next server and Postgres, with PayPal, Gmail and the model faked at the network. Seed data and
// DEMO_CLOCK_OFFSET_DAYS, as CLAUDE.md asks.

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const PROJECT = "00000000-0000-4000-8000-0000000000d1";
const DAY_MS = 24 * 60 * 60 * 1000;

const start = startOfRun();
/** Days ahead of the real clock, for a day this many days into the demo. Rounded for the banner. */
const clockFor = (daysIn: number): number =>
  Math.round(offsetDaysTo(new Date(start.getTime() + daysIn * DAY_MS)) * 100) / 100;

/** The client's calendar date on a day of the demo. */
const clientDate = (daysIn: number): string =>
  new Date(start.getTime() + daysIn * DAY_MS).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });

/** The first 15th after day 21, when the client asks: the "half on the 15th" of the demo. */
const fifteenth = ((): string => {
  const [year = 0, month = 1, day = 1] = clientDate(21).split("-").map(Number);
  const date = new Date(Date.UTC(year, day < 15 ? month - 1 : month, 15));
  return date.toISOString().slice(0, 10);
})();

const daysIntoDemo = (isoDate: string): number =>
  Math.round((Date.parse(`${isoDate}T15:00:00Z`) - start.getTime()) / DAY_MS);

const openProject = (page: Page) => page.goto(`/projects/${PROJECT}`, { waitUntil: "networkidle" });

const invoiceRow = (page: Page, name: string) =>
  page
    .locator("section", { has: page.getByRole("heading", { name: "Invoices" }) })
    .getByRole("row")
    .filter({ hasText: name });

const newestInvoice = async (page: Page) => {
  const { invoices } = await fakeState(page.request);
  const invoice = invoices.at(-1);
  if (!invoice) throw new Error("The fake PayPal has no invoice.");
  return invoice;
};

test("the 8-step demo, end to end", async ({ page }) => {
  await test.step("1. Set up: the seeded $3,000 project, reached from the Projects list", async () => {
    await page.goto("/", { waitUntil: "networkidle" });
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Projects" })
      .click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Website redesign" }).click();
    await expect(page.getByRole("heading", { name: "Website redesign" })).toBeVisible();
    await expect(page.locator("dl.details")).toContainText("Hudson Street Bakery");
    await expect(invoiceRow(page, "Design")).toContainText("USD 900.00");
    await expect(invoiceRow(page, "Build")).toContainText("USD 1,500.00");
    await expect(invoiceRow(page, "Launch")).toContainText("USD 600.00");
    await expect(page.locator("dl.details")).toContainText("payment is due");
    await expect(page.locator("dl.details")).toContainText(/every 3 days/);
  });

  await test.step("2. Deposit: one USD 900 invoice, paid, and the webhook marks it Paid", async () => {
    const row = invoiceRow(page, "Design");
    await row.getByLabel("Deposit due at kickoff").fill("900.00");
    await row.getByRole("button", { name: "Create deposit invoice" }).click();
    await expect(row.getByRole("link", { name: "PayPal pay link" })).toBeVisible();
    const invoice = await newestInvoice(page);
    expect((await payInvoice(page.request, { id: invoice.id, value: "900.00" })).outcome).toBe(
      "applied",
    );
    await openProject(page);
    await expect(invoiceRow(page, "Design")).toContainText("Paid");
  });

  let reminderId = "";
  await test.step("3. Overdue: Tier 2 draft, Telegram card, approved, Outbox moves by itself", async () => {
    const planRow = page.getByRole("row").filter({ has: page.getByLabel("Name of Build") });
    await planRow.getByRole("button", { name: "Mark in progress" }).click();
    await planRow.getByRole("button", { name: "Mark delivered" }).click();
    const row = invoiceRow(page, "Build");
    await row.getByRole("button", { name: "Create invoice" }).click();
    await expect(row.getByRole("link", { name: "PayPal pay link" })).toBeVisible();

    await setClock(page, clockFor(21));
    await expect(page.getByRole("status").filter({ hasText: "Demo clock" })).toBeVisible();
    const run = await runScheduler(page.request);
    expect(run.drafted).toBe(1);

    await page.goto("/outbox", { waitUntil: "networkidle" });
    const card = page.locator("article", { hasText: "Hudson Street Bakery" });
    await expect(card).toContainText("Tier 2");
    await expect(card).toContainText("USD 1,500.00");
    await expect(card).toContainText("client time");
    await expect(card).toContainText("yours");

    const sendCard = (await telegramPending(page.request)).find((op) => op.op === "sendCard");
    expect(sendCard?.text).toContain("Hudson Street Bakery");
    reminderId = sendCard?.reminderId ?? "";
    await telegramDelivered(page.request, reminderId, 501);
    await telegramTap(page.request, sendCard?.data?.approve ?? "", 501);
    // Nothing touches the page: its own refresh moves the card off Waiting.
    await expect(card).toHaveCount(0, { timeout: 15_000 });
  });

  let threadId = "";
  await test.step("4. Delivered: the email reaches the client with the PayPal link", async () => {
    expect((await runSender(page.request)).sent).toBe(1);
    const { sent } = await fakeState(page.request);
    const email = sent.at(-1);
    expect(email?.to).toContain(CLIENT_EMAIL);
    expect(email?.text).toContain("sandbox.paypal.com/invoice");
    threadId = email?.threadId ?? "";
    await page.goto(`/clients/${CLIENT}`, { waitUntil: "networkidle" });
    await expect(page.locator(".timeline")).toContainText("Firm reminder sent (Tier 2)");
  });

  await test.step("5. Client replies: sorted as a split, approved, invoice replaced", async () => {
    await clientReplies(page.request, {
      threadId,
      from: CLIENT_EMAIL,
      text: "Can I pay half now and half on the 15th?",
    });
    expect((await runReplies(page.request)).replies).toBe(1);
    await page.goto("/outbox", { waitUntil: "networkidle" });
    const card = page.getByRole("article", { name: "Reply from Hudson Street Bakery" });
    await expect(card).toContainText("Asks to pay in parts");
    await expect(card).toContainText("half on the 15th");
    const replyCard = (await telegramPending(page.request)).find((op) => op.op === "sendReply");
    expect(replyCard?.text).toContain("half on the 15th");

    await expect(card.getByLabel("Installment 1 amount")).toHaveValue("750.00");
    await expect(card.getByLabel("Installment 2 amount")).toHaveValue("750.00");
    await card.getByLabel("Due").nth(1).fill(fifteenth);
    await card.getByRole("button", { name: "Approve split and replace the invoice" }).click();
    await expect(card).toHaveCount(0);

    await openProject(page);
    const build = invoiceRow(page, "Build");
    await expect(build).toContainText("Installment 1 of 2");
    await expect(build).toContainText("Installment 2 of 2");
    await expect(build).not.toContainText("FPR-000002");

    // The email announcing it goes through the usual approval, reworded from Telegram.
    expect((await runScheduler(page.request)).drafted).toBe(1);
    const first = (await telegramPending(page.request)).find((op) => op.op === "sendCard");
    await telegramDelivered(page.request, first?.reminderId ?? "", 502);
    await telegramTap(page.request, first?.data?.edit ?? "", 502);
    const redrafted = await telegramSay(page.request, "mention the 15th");
    const second = redrafted.find((op) => op.op === "sendCard");
    expect(second?.text).toContain("the 15th");
    await telegramDelivered(page.request, second?.reminderId ?? "", 503);
    await telegramTap(page.request, second?.data?.approve ?? "", 503);

    await setClock(page, clockFor(22));
    expect((await runSender(page.request)).sent).toBe(1);
    const email = (await fakeState(page.request)).sent.at(-1);
    expect(email?.threadId).toBe(threadId);
    expect(email?.text).toContain("the 15th");
  });

  await test.step("6. Installment paid: Partially paid, and the next reminder is for number 2", async () => {
    const { invoices } = await fakeState(page.request);
    const installment1 = invoices.at(-2);
    if (!installment1) throw new Error("The installment invoices are missing.");
    await payInvoice(page.request, { id: installment1.id, value: "750.00" });
    await openProject(page);
    await expect(invoiceRow(page, "Build")).toContainText("Partially paid");
    await expect(invoiceRow(page, "Build")).toContainText("Paid USD 750.00");

    await setClock(page, clockFor(daysIntoDemo(fifteenth) + 1));
    expect((await runScheduler(page.request)).drafted).toBe(1);
    await page.goto("/outbox", { waitUntil: "networkidle" });
    const card = page.locator("article", { hasText: "Hudson Street Bakery" });
    await expect(card).toContainText("Installment 2 of 2");
    await expect(card).toContainText("USD 750.00");
  });

  await test.step("7. Switch AI: a local model redrafts the same email", async () => {
    const before = (await fakeState(page.request)).modelCalls.at(-1);
    expect(before?.model).toBe("claude-sonnet-5-5");
    await page.goto("/settings/ai", { waitUntil: "networkidle" });
    await page.locator("#main-provider").selectOption("ollama");
    await page.locator("#main-model").fill("llama3.2");
    await page.getByRole("button", { name: "Save AI settings" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

    const card = (await telegramPending(page.request)).find((op) => op.op === "sendCard");
    await telegramDelivered(page.request, card?.reminderId ?? "", 504);
    await telegramTap(page.request, card?.data?.edit ?? "", 504);
    await telegramSay(page.request, "make it shorter");
    expect((await fakeState(page.request)).modelCalls.at(-1)?.model).toBe("llama3.2");
    await page.goto("/outbox", { waitUntil: "networkidle" });
    await expect(page.locator("article", { hasText: "Hudson Street Bakery" })).toContainText(
      "Drafted by llama3.2",
    );
  });

  await test.step("8. Close: the amount recovered and the days saved", async () => {
    await page.goto("/", { waitUntil: "networkidle" });
    const recovery = page.locator("section", {
      has: page.getByRole("heading", { name: "Recovery" }),
    });
    await expect(recovery).toContainText("USD 750.00");
    // Installment 1 replaced the invoice due on day 7, and was paid on day 22: 15 days late.
    await expect(recovery).toContainText("15 days late");
    // Against the seed's usual 30 days.
    await expect(recovery).toContainText("15 days");
    await expect(recovery).toContainText("the 30 days you said is usual");
    await expect(recovery).toContainText("1 of 1 paid within 30 days");
    await expect(page.locator("section", { hasText: "Needs attention" })).toContainText(
      "1 draft waiting",
    );

    await page.goto(`/clients/${CLIENT}`, { waitUntil: "networkidle" });
    const timeline = page.locator(".timeline");
    await expect(timeline).toContainText("USD 750.00 paid");
    await expect(timeline).toContainText("Split into 2 installments");
    await expect(timeline).toContainText("Asks to pay in parts");
    await expect(timeline).toContainText("USD 900.00 paid");
    // Newest first, in the demo's own dates: the clock moved, and the order still reads right.
    const titles = await timeline.locator(".timeline-title strong").allTextContents();
    const readable = titles.map((title) => title.replace(/\s/gu, " "));
    const paid = readable.indexOf("USD 750.00 paid");
    const firstSend = readable.indexOf("Firm reminder sent (Tier 2)");
    expect(readable).toContain("USD 750.00 paid");
    expect(paid).toBeLessThan(firstSend);

    // Nothing left this run except to the client, and PayPal's own emails were never used.
    const { sent } = await fakeState(page.request);
    expect(sent.length).toBe(2);
    expect(sent.every((mail) => mail.to.includes(CLIENT_EMAIL))).toBe(true);
  });
});

// After the demo, so what's added here can't change what the demo's scheduler picks up.
test.describe("adding from a list", () => {
  for (const { list, button, form } of [
    { list: "/retainers", button: "Add retainer", form: "/retainers/new" },
    { list: "/maintenance", button: "Add maintenance job", form: "/maintenance/new" },
    { list: "/clients", button: "Add client", form: "/clients/new" },
    { list: "/projects", button: "New project", form: "/projects/new" },
  ]) {
    test(`${button} opens its own page, and Cancel goes back to the list`, async ({ page }) => {
      await page.goto(list, { waitUntil: "networkidle" });
      await expect(page.locator("main form")).toHaveCount(0);
      await page.getByRole("main").getByRole("link", { name: button, exact: true }).click();
      await expect(page).toHaveURL(form);
      await expect(page.locator("main form")).toBeVisible();
      await page.getByRole("main").getByRole("link", { name: "Cancel", exact: true }).click();
      await expect(page).toHaveURL(list);
    });
  }

  test("an empty list offers Add retainer, and a saved one lands back on the list", async ({
    page,
  }) => {
    await page.goto("/retainers", { waitUntil: "networkidle" });
    await expect(page.locator(".empty")).toContainText("No retainers yet");
    await page.locator(".empty").getByRole("link", { name: "Add retainer" }).click();
    await expect(page.locator("#retainer-currency-note")).toBeVisible();
    await page.getByLabel("Name").fill("Monthly care plan");
    await page.getByLabel("Amount").fill("200.00");
    await page.getByRole("button", { name: "Add retainer" }).click();
    await expect(page).toHaveURL("/retainers");
    await expect(page.locator("main")).toContainText("Monthly care plan");
    await expect(
      page.locator(".page-header").getByRole("link", { name: "Add retainer" }),
    ).toBeVisible();
  });

  test("an empty list offers Add maintenance job, and a saved one lands back on the list", async ({
    page,
  }) => {
    await page.goto("/maintenance", { waitUntil: "networkidle" });
    await expect(page.locator(".empty")).toContainText("No jobs or renewals yet");
    await page.locator(".empty").getByRole("link", { name: "Add maintenance job" }).click();
    await page.getByLabel("Task").fill("Security updates");
    await page.getByRole("button", { name: "Add maintenance job" }).click();
    await expect(page).toHaveURL("/maintenance");
    await expect(page.locator("main")).toContainText("Security updates");
    await expect(
      page.locator(".page-header").getByRole("link", { name: "Add maintenance job" }),
    ).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const [name, path] of [
    ["Home", "/"],
    ["Outbox", "/outbox"],
    ["Client", `/clients/${CLIENT}`],
    ["Project", `/projects/${PROJECT}`],
    ["Clients", "/clients"],
    ["Projects", "/projects"],
    ["Retainers", "/retainers"],
    ["Maintenance", "/maintenance"],
    ["Add client", "/clients/new"],
    ["New project", "/projects/new"],
    ["Add retainer", "/retainers/new"],
    ["Add maintenance job", "/maintenance/new"],
  ] as const) {
    test(`${name} fits, with nothing cut off`, async ({ page }) => {
      await page.goto(path, { waitUntil: "networkidle" });
      await expect(page.locator("main h1").first()).toBeVisible();
      const problem = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const overflow = document.documentElement.scrollWidth - width;
        const cut = [...document.querySelectorAll("main button, main input, main select, main a")]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.right > width + 1;
          })
          .map((element) => element.outerHTML.slice(0, 80));
        return { overflow, cut };
      });
      expect(problem).toEqual({ overflow: 0, cut: [] });
    });
  }
});
