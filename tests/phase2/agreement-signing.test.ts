import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signedPdfFile } from "@/lib/agreement-pdf";
import { loadForSigning, respondToAgreement, type SigningDeps } from "@/lib/agreement-signing";
import {
  createDraft,
  getAgreement,
  sendAgreement,
  voidAgreement,
  type Context,
} from "@/lib/agreements";
import { calendarItems } from "@/lib/calendar-feed";
import { createSecretBox } from "@/lib/crypto";
import { runAsUser, type Db } from "@/lib/db";
import { saveGmailConnection } from "@/lib/gmail-account";
import { approveDraft, editDraft } from "@/lib/outbox-actions";
import { loadReminderContext } from "@/lib/reminder-context";
import { runSender, type SenderDeps } from "@/lib/sender";
import { runAsService } from "@/lib/service-db";
import { createSigningLimits, signingHandlers } from "@/lib/signing-handlers";
import { telegramRun } from "@/lib/telegram-cards";
import { USER_A, seedOwnerSql } from "../db/fixtures";
import { openMigratedPglite, type TestDatabase } from "../db/pglite";
import {
  createFakeGmail,
  FAKE_GMAIL_ADDRESS,
  FAKE_REFRESH_TOKEN,
  type FakeGmail,
} from "../mocks/gmail";
import { NO_ARCHIVE } from "../mocks/archive";

// C-S3: the public signing path. A wrong, unknown, used, expired or wrong-status token all get the
// same answer; signing without consent or with a one-letter name is refused; a document that no
// longer matches its hash can't be signed; the token is stored and logged nowhere but in the
// email; the 11th request a minute from one address gets 429. Also the C3 "done when": send,
// approve, open, sign, and the signed PDF in the archive and attached to the signed-copy email.
// Real migrations and RLS (PGlite), Gmail mocked by msw, no real network, no real Chromium.

let handle: TestDatabase;
let gmail: FakeGmail;
const server = setupServer();
const box = createSecretBox(randomBytes(32));
const A = USER_A.userId;
const PROJECT = USER_A.rows.projects;
const APP_URL = "https://app.example.test";
const CLIENT_EMAIL = "client-a@example.test";
/** A Wednesday, 10:00 in New York: inside the default send window. */
const NOW = new Date("2026-12-23T15:00:00Z");
let clock = NOW;
const ctx = (): Context => ({ now: clock, laws: [] });
const OPTIONS = { governingLawCountry: "US" };
const archiveDir = mkdtempSync(join(tmpdir(), "agreement-archive-"));
const rendered: string[] = [];
const SIGNED_PDF = Buffer.from("%PDF-1.7 fake signed agreement");

const asUserId =
  (userId: string) =>
  <T>(work: (db: Db) => Promise<T>): Promise<T> =>
    runAsUser(handle.db, userId, work);
const asA = asUserId(A);

const signingDeps = (): SigningDeps => ({
  runAsService: (work) => runAsService(handle.db, work),
  runAsUser: asUserId,
  now: () => clock,
  renderPdf: (html) => {
    rendered.push(html);
    return Promise.resolve(SIGNED_PDF);
  },
  archiveDir: () => archiveDir,
});

const senderDeps = (): SenderDeps => ({
  runAsService: (work) => runAsService(handle.db, work),
  runAsUser: asUserId,
  now: () => clock,
  box: () => box,
  oauth: () => ({ clientId: "fake-client-id", clientSecret: "fake-client-secret" }),
  allowlist: () => new Set([CLIENT_EMAIL]),
  pdf: () => Promise.resolve(undefined),
  signedPdf: (userId, agreementId) =>
    asUserId(userId)((db) => signedPdfFile(db, archiveDir, agreementId)),
  archive: NO_ARCHIVE,
});

type Sent = { id: string; token: string; reminderId: string };

/** Voids anything in progress, then drafts and sends a new agreement with a token the test knows. */
const sendOne = async (): Promise<Sent> => {
  await handle.db.query(
    "UPDATE public.agreements SET status = 'void', token_sha256 = NULL WHERE project_id = $1 AND status IN ('draft', 'sent')",
    [PROJECT],
  );
  const draft = await asA((db) => createDraft(db, PROJECT, OPTIONS, ctx()));
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft)}`);
  const token = randomBytes(32).toString("base64url");
  const sent = await asA((db) =>
    sendAgreement(db, draft.agreement.id, { freelancerSignedName: "Alex Rivera" }, ctx(), {
      token: () => token,
      appUrl: APP_URL,
    }),
  );
  if (!sent.ok) throw new Error(`send failed: ${JSON.stringify(sent)}`);
  const { rows } = await handle.db.query<{ id: string }>(
    "SELECT id::text FROM public.reminders WHERE agreement_id = $1 AND tier = 'agreement_request'",
    [draft.agreement.id],
  );
  return { id: draft.agreement.id, token, reminderId: rows[0]?.id ?? "" };
};

const statusOf = async (id: string): Promise<string> =>
  (
    await handle.db.query<{ status: string }>(
      "SELECT status FROM public.agreements WHERE id = $1",
      [id],
    )
  ).rows[0]?.status ?? "missing";

const SIGN = { action: "sign", name: "Sam Lee", consent: true };
const WHO = { ip: "203.0.113.9", userAgent: "TestBrowser/1.0" };

const respond = (token: string, body: unknown = SIGN) =>
  respondToAgreement(signingDeps(), token, body, WHO);

beforeAll(async () => {
  handle = await openMigratedPglite();
  await handle.db.query(seedOwnerSql(USER_A));
  server.listen({ onUnhandledFrame: "error" });
  await handle.db.query("UPDATE public.clients SET email = $1 WHERE user_id = $2", [
    CLIENT_EMAIL,
    A,
  ]);
  await handle.db.query("UPDATE public.users SET telegram_chat_id = 7001 WHERE id = $1", [A]);
  await asA((db) =>
    saveGmailConnection(db, {
      userId: A,
      refreshToken: FAKE_REFRESH_TOKEN,
      email: FAKE_GMAIL_ADDRESS,
      box,
    }),
  );
}, 60_000);

beforeEach(async () => {
  clock = NOW;
  await handle.db.query("DELETE FROM public.messages WHERE gmail_message_id IS NOT NULL");
  rendered.length = 0;
  gmail = createFakeGmail();
  server.use(...gmail.handlers);
});

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  server.close();
  await handle.close();
});

describe("sending an agreement", () => {
  it("freezes the document, keeps only the token's hash, and leaves an email waiting for approval", async () => {
    const { id, token, reminderId } = await sendOne();
    const agreement = await asA((db) => getAgreement(db, id));
    expect(agreement).toMatchObject({ status: "sent", freelancerSignedName: "Alex Rivera" });
    expect(agreement?.tokenExpiresAt).toBe("2027-01-22T15:00:00.000Z");
    expect(agreement?.facts.lateFeeClauseText).toContain("law that applies");
    // The token appears in no column of the agreement, only (as a link) in the email draft.
    const { rows } = await handle.db.query<{ everything: string }>(
      "SELECT a::text AS everything FROM public.agreements a WHERE a.id = $1",
      [id],
    );
    expect(rows[0]?.everything).not.toContain(token);
    const draft = await handle.db.query<{
      body: string;
      approval_status: string;
      sent_at: unknown;
    }>(
      "SELECT draft ->> 'body' AS body, approval_status, sent_at FROM public.reminders WHERE id = $1",
      [reminderId],
    );
    expect(draft.rows[0]?.body).toContain(`${APP_URL}/sign/${token}`);
    expect(draft.rows[0]).toMatchObject({ approval_status: "waiting", sent_at: null });
    const others = await handle.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.reminders WHERE draft::text LIKE $1 AND id <> $2",
      [`%${token}%`, reminderId],
    );
    expect(others.rows[0]?.n).toBe(0);
    expect(gmail.state.sent).toHaveLength(0);
  });

  it("refuses to send a second time, with no name, or without a public address", async () => {
    const { id } = await sendOne();
    expect(
      await asA((db) =>
        sendAgreement(db, id, { freelancerSignedName: "Alex" }, ctx(), {
          token: () => "x",
          appUrl: APP_URL,
        }),
      ),
    ).toMatchObject({
      ok: false,
      conflict: expect.stringContaining("can't be sent again") as string,
    });
    await handle.db.query("UPDATE public.agreements SET status = 'void' WHERE id = $1", [id]);
    const draft = await asA((db) => createDraft(db, PROJECT, OPTIONS, ctx()));
    if (!draft.ok) throw new Error("draft");
    expect(
      await asA((db) =>
        sendAgreement(db, draft.agreement.id, { freelancerSignedName: "A" }, ctx(), {
          token: () => "x",
          appUrl: APP_URL,
        }),
      ),
    ).toMatchObject({ ok: false, errors: [{ field: "freelancerSignedName" }] });
    expect(
      await asA((db) =>
        sendAgreement(db, draft.agreement.id, { freelancerSignedName: "Alex Rivera" }, ctx(), {
          token: () => "x",
          appUrl: undefined,
        }),
      ),
    ).toMatchObject({ ok: false, conflict: expect.stringContaining("APP_PUBLIC_URL") as string });
    expect(await statusOf(draft.agreement.id)).toBe("draft");
    await asA((db) => voidAgreement(db, draft.agreement.id));
  });

  it("can't be edited in the Outbox, and an approval needs the signing link intact", async () => {
    const { reminderId } = await sendOne();
    expect(
      await asA((db) =>
        editDraft(
          db,
          reminderId,
          { subject: "Hi", body: "Sign here: https://evil.test/x" },
          { now: clock, laws: [] },
        ),
      ),
    ).toMatchObject({
      status: "conflict",
      message: expect.stringContaining("fixed text") as string,
    });
    await handle.db.query(
      "UPDATE public.reminders SET draft = jsonb_set(draft, '{body}', '\"Sign here: https://evil.test/x\"') WHERE id = $1",
      [reminderId],
    );
    expect(await asA((db) => approveDraft(db, reminderId))).toMatchObject({ status: "conflict" });
  });

  it("goes to the client only after approval, on the agreement's own thread", async () => {
    const { id, token, reminderId } = await sendOne();
    expect(await runSender(senderDeps())).toEqual({ sent: 0, held: 0 });
    expect(gmail.state.sent).toHaveLength(0);
    expect(await asA((db) => approveDraft(db, reminderId))).toEqual({ status: "ok" });
    expect(await runSender(senderDeps())).toMatchObject({ sent: 1 });
    const mail = Buffer.from(gmail.state.sent[0]?.raw ?? "", "base64url").toString("utf8");
    expect(mail).toContain(`To: "Client a" <${CLIENT_EMAIL}>`);
    expect(mail).not.toContain("application/pdf");
    const draftBody = await handle.db.query<{ body: string }>(
      "SELECT draft ->> 'body' AS body FROM public.reminders WHERE id = $1",
      [reminderId],
    );
    expect(draftBody.rows[0]?.body).toContain(`${APP_URL}/sign/${token}`);
    expect(mail.replace(/\r\n/g, "")).toContain(
      Buffer.from(draftBody.rows[0]?.body ?? "?", "utf8").toString("base64"),
    );
    const thread = await handle.db.query<{ gmail_thread_id: string | null }>(
      "SELECT gmail_thread_id FROM public.agreements WHERE id = $1",
      [id],
    );
    expect(thread.rows[0]?.gmail_thread_id).toBe("thread-1");
    const messages = await handle.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.messages WHERE agreement_id = $1 AND direction = 'out'",
      [id],
    );
    expect(messages.rows[0]?.n).toBe(1);
  });

  it("skips the waiting email when the agreement is voided or its link expires", async () => {
    const voided = await sendOne();
    await asA((db) => voidAgreement(db, voided.id));
    const expired = await sendOne();
    clock = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
    await loadForSigning(signingDeps(), expired.token);
    const { rows } = await handle.db.query<{ approval_status: string }>(
      "SELECT approval_status FROM public.reminders WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[voided.reminderId, expired.reminderId]],
    );
    expect(rows.map((r) => r.approval_status)).toEqual(["skipped", "skipped"]);
  });

  it("is a calendar item: the last day the link works", async () => {
    const { id } = await sendOne();
    const items = await asA((db) =>
      calendarItems(db, { from: "2027-01-01", to: "2027-02-28", zone: "UTC" }),
    );
    expect(items.find((item) => item.key === `agreement:${id}`)).toMatchObject({
      type: "agreement_deadline",
      startsOn: "2027-01-22",
    });
  });
});

describe("the signing token (C-S3)", () => {
  it("shows the document once for a good link, and records the first view only once", async () => {
    const { id, token } = await sendOne();
    const view = await loadForSigning(signingDeps(), token);
    expect(view).toMatchObject({
      status: "sent",
      clientName: "Client a",
      freelancerName: "Freelancer a",
    });
    expect(view?.html).toContain("Project agreement");
    const first = await handle.db.query<{ first_viewed_at: Date }>(
      "SELECT first_viewed_at FROM public.agreements WHERE id = $1",
      [id],
    );
    clock = new Date(NOW.getTime() + 60_000);
    await loadForSigning(signingDeps(), token);
    const second = await handle.db.query<{ first_viewed_at: Date }>(
      "SELECT first_viewed_at FROM public.agreements WHERE id = $1",
      [id],
    );
    expect(second.rows[0]?.first_viewed_at.toISOString()).toBe(
      first.rows[0]?.first_viewed_at.toISOString(),
    );
  });

  it("answers a wrong, unknown, malformed, voided, expired and used token the same way", async () => {
    const live = await sendOne();
    const wrong = randomBytes(32).toString("base64url");
    const voided = await sendOne();
    await handle.db.query("UPDATE public.agreements SET status = 'void' WHERE id = $1", [
      voided.id,
    ]);
    const expired = await sendOne();
    clock = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
    const used = await sendOne();
    clock = NOW;
    expect((await respond(used.token)).status).toBe("signed");
    const bad = [
      wrong,
      "short",
      "",
      "x".repeat(43),
      live.token.replace(/.$/, "!"),
      voided.token,
      expired.token,
      used.token,
    ];
    for (const token of bad) {
      expect(await loadForSigning(signingDeps(), token)).toBeUndefined();
      expect(await respond(token)).toEqual({ status: "not_found" });
    }
  });

  it("marks an agreement expired when its link is opened after 30 days", async () => {
    const { id, token } = await sendOne();
    clock = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(await loadForSigning(signingDeps(), token)).toBeUndefined();
    expect(await statusOf(id)).toBe("expired");
  });

  it("refuses to sign without consent, with a one-letter name, or with anything extra", async () => {
    const { id, token } = await sendOne();
    for (const body of [
      { action: "sign", name: "Sam Lee", consent: false },
      { action: "sign", name: "Sam Lee" },
      { action: "sign", name: "S", consent: true },
      { action: "sign", name: "Sam Lee", consent: true, status: "signed" },
      { action: "approve", name: "Sam Lee", consent: true },
      "sign",
    ]) {
      expect(await respond(token, body)).toMatchObject({ status: "invalid" });
    }
    expect(await statusOf(id)).toBe("sent");
    expect(rendered).toHaveLength(0);
  });

  it("can't be signed when the document no longer matches its hash", async () => {
    const { id, token } = await sendOne();
    // Only a database owner can do this: the freeze trigger stops everyone else.
    await handle.db.query("ALTER TABLE public.agreements DISABLE TRIGGER agreements_freeze");
    await handle.db.query(
      "UPDATE public.agreements SET body_html = body_html || '<p>Changed</p>' WHERE id = $1",
      [id],
    );
    await handle.db.query("ALTER TABLE public.agreements ENABLE TRIGGER agreements_freeze");
    expect(await respond(token)).toMatchObject({ status: "conflict" });
    expect(await statusOf(id)).toBe("sent");
    expect(rendered).toHaveLength(0);
  });

  it("signs: records who, when and from where, clears the token, and keeps the PDF with its certificate", async () => {
    const { id, token } = await sendOne();
    expect(await respond(token, { ...SIGN, name: "  Sam Lee  " })).toEqual({ status: "signed" });
    const agreement = await asA((db) => getAgreement(db, id));
    expect(agreement).toMatchObject({ status: "signed", signedAt: NOW.toISOString() });
    const row = await handle.db.query<Record<string, string | null>>(
      "SELECT signer_name, signer_email, signer_ip, signer_user_agent, token_sha256, signed_pdf_path, signed_pdf_sha256 FROM public.agreements WHERE id = $1",
      [id],
    );
    expect(row.rows[0]).toMatchObject({
      signer_name: "Sam Lee",
      signer_email: CLIENT_EMAIL,
      signer_ip: "203.0.113.9",
      signer_user_agent: "TestBrowser/1.0",
      token_sha256: null,
    });
    const path = row.rows[0]?.signed_pdf_path ?? "";
    expect(path).toMatch(/^Client a\/Website redesign\/Agreements\/AGR-\d{6}-v1\.pdf$/);
    expect(existsSync(join(archiveDir, path))).toBe(true);
    expect(readFileSync(join(archiveDir, path))).toEqual(SIGNED_PDF);
    const html = rendered[0] ?? "";
    expect(html).toContain("Certificate of electronic signature");
    for (const fact of [
      "Sam Lee",
      "203.0.113.9",
      "TestBrowser",
      agreement?.bodySha256 ?? "?",
      "Alex Rivera",
      "(UTC)",
      "agreed to sign this agreement electronically",
    ]) {
      expect(html).toContain(fact);
    }
    const events = await handle.db.query<{ type: string }>(
      "SELECT type FROM public.events WHERE entity = 'agreement' AND entity_id = $1 ORDER BY created_at, type",
      [id],
    );
    expect(events.rows.map((e) => e.type)).toEqual(
      expect.arrayContaining(["agreement.sent", "agreement.signed"]),
    );
  });

  it("escapes what the signer typed in the certificate", async () => {
    const { token } = await sendOne();
    await respondToAgreement(signingDeps(), token, SIGN, {
      ip: "203.0.113.9",
      userAgent: '<script>alert("x")</script>',
    });
    expect(rendered[0]).not.toContain('<script>alert("x")</script>');
    expect(rendered[0]).toContain("&lt;script&gt;");
  });

  it("declines with a reason, clears the token, makes no PDF, and tells the freelancer on Telegram", async () => {
    const { id, token } = await sendOne();
    expect(await respond(token, { action: "decline", reason: "  Too expensive  " })).toEqual({
      status: "declined",
    });
    expect(await respond(token, { action: "decline", reason: "x".repeat(1001) })).toEqual({
      status: "not_found",
    });
    const row = await handle.db.query<Record<string, string | null>>(
      "SELECT status, decline_reason, token_sha256, signed_pdf_path FROM public.agreements WHERE id = $1",
      [id],
    );
    expect(row.rows[0]).toEqual({
      status: "declined",
      decline_reason: "Too expensive",
      token_sha256: null,
      signed_pdf_path: null,
    });
    expect(rendered).toHaveLength(0);
    const ops = await runAsService(handle.db, (db) => telegramRun(db, clock, undefined));
    const notice = ops.find((op) => op.op === "sendText" && op.text.includes("declined agreement"));
    expect(notice).toMatchObject({
      chatId: 7001,
      text: expect.stringContaining("Too expensive") as string,
    });
  });

  it("limits a long reason before saving", async () => {
    const { token } = await sendOne();
    expect(await respond(token, { action: "decline", reason: "x".repeat(1001) })).toMatchObject({
      status: "invalid",
    });
  });
});

describe("the signed copy", () => {
  it("is an Outbox draft with the signed PDF attached, sent only after approval", async () => {
    const { id, token } = await sendOne();
    await respond(token);
    const copy = await handle.db.query<{ id: string; body: string; approval_status: string }>(
      "SELECT id::text, draft ->> 'body' AS body, approval_status FROM public.reminders WHERE agreement_id = $1 AND tier = 'agreement_signed_copy'",
      [id],
    );
    expect(copy.rows).toHaveLength(1);
    expect(copy.rows[0]).toMatchObject({ approval_status: "waiting" });
    expect(copy.rows[0]?.body).not.toMatch(/https?:\/\//);
    expect(await runSender(senderDeps())).toEqual({ sent: 0, held: 0 });
    expect(await asA((db) => approveDraft(db, copy.rows[0]?.id ?? ""))).toEqual({ status: "ok" });
    const result = await runSender(senderDeps());
    const why = await handle.db.query<{ id: string; send_blocked_reason: string | null }>(
      "SELECT id::text, send_blocked_reason FROM public.reminders WHERE approval_status = 'approved' AND sent_at IS NULL",
    );
    expect({ result, why: why.rows.map((r) => r.send_blocked_reason) }).toEqual({
      result: { sent: 1, held: 0 },
      why: [],
    });
    const mail = Buffer.from(gmail.state.sent[0]?.raw ?? "", "base64url").toString("utf8");
    expect(mail).toContain("application/pdf");
    expect(mail).toContain(SIGNED_PDF.toString("base64"));
    expect(mail).toContain("-signed.pdf");
    const telegram = await runAsService(handle.db, (db) => telegramRun(db, clock, undefined));
    expect(
      telegram.some((op) => op.op === "sendText" && op.text.includes("signed agreement")),
    ).toBe(true);
  });

  it("is held, not sent, when the signed PDF can't be read", async () => {
    const { id, token } = await sendOne();
    await respond(token);
    const copy = await handle.db.query<{ id: string }>(
      "SELECT id::text FROM public.reminders WHERE agreement_id = $1 AND tier = 'agreement_signed_copy'",
      [id],
    );
    await handle.db.query(
      "UPDATE public.agreements SET signed_pdf_path = 'Nowhere/Missing.pdf' WHERE id = $1",
      [id],
    );
    await asA((db) => approveDraft(db, copy.rows[0]?.id ?? ""));
    expect(await runSender(senderDeps())).toMatchObject({ sent: 0, held: 1 });
    expect(gmail.state.sent).toHaveLength(0);
  });

  it("is what Tier 3 quotes once an agreement is signed", async () => {
    const { id, token } = await sendOne();
    await handle.db.query(
      "UPDATE public.projects SET late_fee_clause = 'The project clause.' WHERE id = $1",
      [PROJECT],
    );
    await respond(token);
    const after = await asA((db) => loadReminderContext(db, USER_A.rows.reminders));
    const agreement = await asA((db) => getAgreement(db, id));
    expect(after?.project?.lateFeeClause).toBe(agreement?.facts.lateFeeClauseText);
    expect(after?.project?.lateFeeClause).not.toBe("The project clause.");
  });
});

describe("the public API", () => {
  const request = (token: string, address: string, method = "GET", body?: unknown) =>
    new Request(`http://app.test/api/sign/${token}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `${address}, 10.0.0.1`,
        "user-agent": "TestBrowser/1.0",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const context = (token: string) => ({ params: Promise.resolve({ token }) });

  it("answers every bad token with the same 404", async () => {
    const live = await sendOne();
    const handlers = signingHandlers({ ...signingDeps(), limits: createSigningLimits() });
    await respond(live.token);
    const answers = await Promise.all(
      [randomBytes(32).toString("base64url"), "nope", live.token].map(async (token) => {
        const get = await handlers.get(request(token, "198.51.100.1"), context(token));
        const post = await handlers.post(
          request(token, "198.51.100.2", "POST", SIGN),
          context(token),
        );
        return [get.status, await get.text(), post.status, await post.text()];
      }),
    );
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]?.[0]).toBe(404);
  });

  it("refuses the 11th request in a minute from one address, and a different address is fine", async () => {
    const handlers = signingHandlers({ ...signingDeps(), limits: createSigningLimits() });
    const token = randomBytes(32).toString("base64url");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push(
        (
          await handlers.get(
            request(`${token.slice(0, 42)}${String(i % 10)}`, "198.51.100.7"),
            context(`${token.slice(0, 42)}${String(i % 10)}`),
          )
        ).status,
      );
    }
    expect(statuses.slice(0, 10)).toEqual(Array<number>(10).fill(404));
    expect(statuses[10]).toBe(429);
    expect((await handlers.get(request(token, "198.51.100.8"), context(token))).status).toBe(404);
    clock = new Date(NOW.getTime() + 61_000);
    expect((await handlers.get(request(token, "198.51.100.7"), context(token))).status).toBe(404);
  });

  it("limits one token to 20 requests an hour, whoever asks", async () => {
    const handlers = signingHandlers({ ...signingDeps(), limits: createSigningLimits() });
    const token = randomBytes(32).toString("base64url");
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      statuses.push(
        (await handlers.get(request(token, `198.51.100.${String(i + 20)}`), context(token))).status,
      );
    }
    expect(statuses[20]).toBe(429);
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
  });

  it("signs through the API, and logs no token, name, address or document text", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const { token } = await sendOne();
    const handlers = signingHandlers({ ...signingDeps(), limits: createSigningLimits() });
    const view = await handlers.get(request(token, "198.51.100.30"), context(token));
    expect(view.status).toBe(200);
    expect(Object.keys((await view.json()) as object).sort()).toEqual([
      "clientName",
      "freelancerName",
      "html",
      "status",
    ]);
    const done = await handlers.post(request(token, "198.51.100.30", "POST", SIGN), context(token));
    expect(done.status).toBe(200);
    const logged = writes.join("\n");
    expect(logged).toContain("agreements.signed");
    for (const secret of [
      token,
      "Sam Lee",
      "198.51.100.30",
      "TestBrowser",
      "Project agreement",
      CLIENT_EMAIL,
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
