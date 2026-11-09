import { z } from "zod";
import { sha256Hex, signedCopyDraft } from "./agreement-email";
import { renderSignedPdf, saveSignedPdf, type SignedFacts } from "./agreement-pdf";
import { getAgreement, skipUnsentRequest, type Agreement } from "./agreements";
import type { Db, UserDbRunner } from "./db";
import { toFieldIssues, type FieldIssue } from "./field-issues";
import { logEvent } from "./log";
import type { ServiceDbRunner } from "./service-db";

// Server-only: the client's side of an agreement, with no login. The signing token is the only
// credential, so everything here is careful: an unknown, used, expired or wrong-status token all
// look the same (undefined / not_found); the token is looked up by its hash with the service role
// (that lookup only), and everything after it runs as the agreement's own user (RLS). The token
// itself is never stored, logged or returned.

export type SigningDeps = {
  runAsService: ServiceDbRunner;
  runAsUser: (userId: string) => UserDbRunner;
  now: () => Date;
  /** Chromium in the app, a fake in tests. */
  renderPdf: (html: string) => Promise<Buffer>;
  archiveDir: () => string;
};

/** 32 random bytes as base64url is always 43 characters; anything else can't be a token. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

type Ref = { agreementId: string; userId: string };

const findByToken = async (deps: SigningDeps, token: string): Promise<Ref | undefined> => {
  if (!TOKEN_SHAPE.test(token)) return undefined;
  return deps.runAsService(async (db) => {
    const { rows } = await db.query<{ id: string; user_id: string }>(
      `SELECT id::text, user_id::text FROM public.agreements
       WHERE token_sha256 = $1 AND status = 'sent'`,
      [sha256Hex(token)],
    );
    const row = rows[0];
    return row ? { agreementId: row.id, userId: row.user_id } : undefined;
  });
};

/** The agreement if it's still waiting for the client; an expired one is marked so. */
const openAgreement = async (db: Db, id: string, now: Date): Promise<Agreement | undefined> => {
  const agreement = await getAgreement(db, id);
  if (agreement?.status !== "sent") return undefined;
  if (!agreement.tokenExpiresAt || new Date(agreement.tokenExpiresAt) <= now) {
    await db.query(
      "UPDATE public.agreements SET status = 'expired', token_sha256 = NULL WHERE id = $1 AND status = 'sent'",
      [id],
    );
    await skipUnsentRequest(db, id);
    return undefined;
  }
  return agreement;
};

export type SigningView = {
  html: string;
  freelancerName: string;
  clientName: string;
  status: "sent";
};

/** What the signing page shows. Records the first time it was opened. Undefined for any bad token. */
export const loadForSigning = async (
  deps: SigningDeps,
  token: string,
): Promise<SigningView | undefined> => {
  const ref = await findByToken(deps, token);
  if (!ref) return undefined;
  return deps.runAsUser(ref.userId)(async (db) => {
    const now = deps.now();
    const agreement = await openAgreement(db, ref.agreementId, now);
    if (!agreement) return undefined;
    await db.query(
      "UPDATE public.agreements SET first_viewed_at = $2 WHERE id = $1 AND first_viewed_at IS NULL",
      [ref.agreementId, now.toISOString()],
    );
    return {
      html: agreement.bodyHtml,
      freelancerName: agreement.facts.freelancer.legalName,
      clientName: agreement.facts.client.name,
      status: "sent",
    };
  });
};

const signAction = z.strictObject({
  action: z.literal("sign"),
  name: z
    .string({ error: "is required" })
    .trim()
    .min(2, "must be your full name")
    .max(160, "must be 160 characters or fewer"),
  consent: z.literal(true, { error: "must be ticked to sign" }),
});
const declineAction = z.strictObject({
  action: z.literal("decline"),
  reason: z.string().trim().max(1000, "must be 1,000 characters or fewer").default(""),
});
const responseSchema = z.discriminatedUnion("action", [signAction, declineAction]);

export type Respondent = { ip: string; userAgent: string };

export type Outcome =
  | { status: "signed" }
  | { status: "declined" }
  | { status: "not_found" }
  | { status: "invalid"; errors: FieldIssue[] }
  | { status: "conflict"; message: string };

const NOT_FOUND: Outcome = { status: "not_found" };

const record = (db: Db, id: string, type: string, payload: object) =>
  db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ((SELECT auth.uid()), 'agreement', $1, $2, $3)`,
    [id, type, JSON.stringify(payload)],
  );

const sign = async (
  deps: SigningDeps,
  ref: Ref,
  input: z.infer<typeof signAction>,
  who: Respondent,
): Promise<Outcome> => {
  const run = deps.runAsUser(ref.userId);
  const loaded = await run(async (db) => {
    const agreement = await openAgreement(db, ref.agreementId, deps.now());
    if (!agreement) return undefined;
    const { rows } = await db.query<{ client_zone: string; own_zone: string }>(
      `SELECT c.time_zone AS client_zone, u.time_zone AS own_zone
       FROM public.clients c, public.users u WHERE c.id = $1 AND u.id = (SELECT auth.uid())`,
      [agreement.clientId],
    );
    return { agreement, zones: rows[0] };
  });
  if (!loaded) return NOT_FOUND;
  const { agreement, zones } = loaded;
  // The document must still be exactly what was sent: the database refuses edits, and this checks it.
  if (sha256Hex(agreement.bodyHtml) !== agreement.bodySha256) {
    logEvent("agreements.document_mismatch", { agreementId: ref.agreementId });
    return {
      status: "conflict",
      message:
        "This agreement can't be signed because its document doesn't match what was sent. Ask the sender for a new link.",
    };
  }
  const signedAt = deps.now();
  const facts: SignedFacts = {
    agreement,
    signerName: input.name,
    signerEmail: agreement.facts.client.email,
    signerIp: who.ip,
    signerUserAgent: who.userAgent,
    signedAt,
    freelancerZone: zones?.own_zone ?? "UTC",
    clientZone: zones?.client_zone ?? "UTC",
  };
  const pdf = await renderSignedPdf(facts, deps.renderPdf);
  const saved = await saveSignedPdf(deps.archiveDir(), agreement, pdf);
  return run(async (db): Promise<Outcome> => {
    const { rowCount } = await db.query(
      `UPDATE public.agreements
       SET status = 'signed', signer_name = $2, signer_email = $3, signer_ip = $4,
         signer_user_agent = $5, signed_at = $6, token_sha256 = NULL,
         signed_pdf_path = $7, signed_pdf_sha256 = $8
       WHERE id = $1 AND status = 'sent'`,
      [
        ref.agreementId,
        input.name,
        facts.signerEmail,
        who.ip,
        who.userAgent,
        signedAt.toISOString(),
        saved.relativePath,
        saved.sha256,
      ],
    );
    if (rowCount === 0) return NOT_FOUND;
    await record(db, ref.agreementId, "agreement.signed", {
      number: agreement.number,
      version: agreement.version,
    });
    const { rows } = await db.query<{ name: string }>(
      "SELECT name FROM public.users WHERE id = (SELECT auth.uid())",
    );
    const draft = signedCopyDraft(
      {
        clientName: agreement.facts.client.name,
        projectTitle: agreement.facts.project.title,
        freelancerName: rows[0]?.name ?? agreement.facts.freelancer.legalName,
      },
      signedAt,
    );
    await db.query(
      `INSERT INTO public.reminders (user_id, agreement_id, tier, scheduled_at, draft)
       VALUES ((SELECT auth.uid()), $1, 'agreement_signed_copy', $2, $3)`,
      [ref.agreementId, signedAt.toISOString(), JSON.stringify(draft)],
    );
    return { status: "signed" };
  });
};

const decline = (
  deps: SigningDeps,
  ref: Ref,
  input: z.infer<typeof declineAction>,
): Promise<Outcome> =>
  deps.runAsUser(ref.userId)(async (db): Promise<Outcome> => {
    const agreement = await openAgreement(db, ref.agreementId, deps.now());
    if (!agreement) return NOT_FOUND;
    const { rowCount } = await db.query(
      `UPDATE public.agreements SET status = 'declined', decline_reason = $2, token_sha256 = NULL
       WHERE id = $1 AND status = 'sent'`,
      [ref.agreementId, input.reason || null],
    );
    if (rowCount === 0) return NOT_FOUND;
    await record(db, ref.agreementId, "agreement.declined", {
      number: agreement.number,
      version: agreement.version,
    });
    return { status: "declined" };
  });

/**
 * The client's answer: sign (a full name and the consent tick) or decline. The token is checked
 * first, so a bad token is a plain not_found whatever was sent with it.
 */
export const respondToAgreement = async (
  deps: SigningDeps,
  token: string,
  raw: unknown,
  who: Respondent,
): Promise<Outcome> => {
  const ref = await findByToken(deps, token);
  if (!ref) return NOT_FOUND;
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "invalid", errors: toFieldIssues(parsed.error, { noun: "field" }) };
  }
  const outcome =
    parsed.data.action === "sign"
      ? await sign(deps, ref, parsed.data, who)
      : await decline(deps, ref, parsed.data);
  if (outcome.status === "signed" || outcome.status === "declined") {
    logEvent(`agreements.${outcome.status}`, { agreementId: ref.agreementId });
  }
  return outcome;
};
