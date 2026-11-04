import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getResponse, http, HttpResponse } from "msw";
import { FAKE_PORT } from "./env";
import { createFakeGmail } from "../mocks/gmail";
import { createFakePaypal } from "../mocks/paypal";

// The outside world for the E2E, as its own process: the same fake PayPal and Gmail the integration
// tests use, plus a fake model. tests/e2e/fake-network.cjs sends the app's calls here, and the test
// drives it through /__control (a client paying, a client replying).

const paypal = createFakePaypal();
const gmail = createFakeGmail();
const modelCalls: { model: string; kind: string }[] = [];

type ChatBody = { model: string; messages: { role: string; content: string }[] };

const between = (text: string, tag: string): string | undefined =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1];

const classification = (reply: string) => ({
  label: /half|split|part/i.test(reply) ? "installments" : "unclear",
  promisedDate: null,
  returnDate: null,
  summary: "The client asks to pay half now and half later.",
});

/** A draft that passes the app's real checks: it only says what the facts and the note say. */
const draftFrom = (user: string) => {
  const facts = JSON.parse(between(user, "facts") ?? "{}") as Record<string, string>;
  const note = between(user, "feedback") ?? "";
  const named = /the \d{1,2}(?:st|nd|rd|th)/i.exec(note)?.[0];
  const lines = [
    `Hi ${facts.clientName ?? "there"},`,
    `Invoice ${facts.invoiceNumber ?? ""} for ${facts.amountDue ?? ""} is overdue. Please pay here:`,
    facts.payLink ?? "",
    ...(named ? [`I can also take the rest on ${named}.`] : []),
    `Thanks, ${facts.freelancerName ?? ""}`,
  ];
  return { subject: `Invoice ${facts.invoiceNumber ?? ""}`, body: lines.join("\n") };
};

const answer = (body: ChatBody): object => {
  const [system, user] = body.messages;
  const isSort = system?.content.includes("sort a client's email reply") ?? false;
  modelCalls.push({ model: body.model, kind: isSort ? "sort" : "draft" });
  return isSort
    ? classification(JSON.stringify(between(user?.content ?? "", "reply") ?? ""))
    : draftFrom(user?.content ?? "");
};

const model = http.post("*/chat/completions", async ({ request }) => {
  const reply = answer((await request.json()) as ChatBody);
  return HttpResponse.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
});

const handlers = [...paypal.handlers, ...gmail.handlers, model];

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      done(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", fail);
  });

const sendJson = (response: ServerResponse, value: unknown, status = 200): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

/** The text of a sent email, whatever its encoding: for reading it back in the test. */
const sentMail = () =>
  gmail.state.sent.map(({ raw, threadId }) => {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const parts = text.split(/\r\n/).filter((line) => /^[A-Za-z0-9+/=]+$/.test(line));
    const decoded = parts.map((line) => Buffer.from(line, "base64").toString("utf8")).join("");
    return {
      threadId,
      to: gmail.headerValue(raw, "To") ?? "",
      subject: gmail.headerValue(raw, "Subject") ?? "",
      text: `${text}\n${decoded}`,
    };
  });

const invoiceList = () =>
  [...paypal.invoices.values()].map((invoice) => ({
    id: invoice.id,
    number: (invoice.body.detail as { invoice_number?: string }).invoice_number ?? "",
    status: invoice.status,
  }));

const control = (path: string, body: Record<string, string>, response: ServerResponse): void => {
  if (path === "/__control/state") {
    sendJson(response, { invoices: invoiceList(), sent: sentMail(), modelCalls });
    return;
  }
  if (path === "/__control/pay") {
    const id = body.paypalInvoiceId ?? "";
    paypal.pay(id, body.value ?? "0.00", "PAID");
    sendJson(response, { ok: true });
    return;
  }
  if (path === "/__control/reply") {
    const threadId = body.threadId ?? "";
    const thread = gmail.state.threads.get(threadId) ?? [];
    thread.push({
      id: `reply-${String(thread.length + 1)}-${threadId}`,
      from: body.from ?? "",
      body: body.text ?? "",
    });
    gmail.state.threads.set(threadId, thread);
    sendJson(response, { ok: true });
    return;
  }
  sendJson(response, { error: `No control ${path}` }, 404);
};

const forward = async (
  request: IncomingMessage,
  response: ServerResponse,
  text: string,
): Promise<void> => {
  const original = String(request.headers["x-e2e-original-url"]);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string" && !["host", "content-length"].includes(name)) {
      headers.set(name, value);
    }
  }
  const method = request.method ?? "GET";
  const mocked = await getResponse(
    handlers,
    new Request(original, {
      method,
      headers,
      ...(["GET", "HEAD"].includes(method) ? {} : { body: text }),
    }),
  );
  if (!mocked) {
    process.stderr.write(`E2E fake services: nothing handles ${method} ${original}\n`);
    sendJson(response, { error: `Nothing handles ${method} ${original}` }, 500);
    return;
  }
  const out = await mocked.text();
  response.writeHead(mocked.status, Object.fromEntries(mocked.headers.entries()));
  response.end(mocked.status === 204 ? undefined : out);
};

createServer((request, response) => {
  void (async () => {
    const text = await readBody(request);
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    if (path === "/__fake") {
      await forward(request, response, text);
      return;
    }
    control(path, text ? (JSON.parse(text) as Record<string, string>) : {}, response);
  })().catch((error: unknown) => {
    process.stderr.write(`E2E fake services failed: ${String(error)}\n`);
    sendJson(response, { error: String(error) }, 500);
  });
}).listen(FAKE_PORT, "127.0.0.1");
