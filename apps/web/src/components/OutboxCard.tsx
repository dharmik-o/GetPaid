"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode, type SyntheticEvent } from "react";
import { Icon } from "@/components/Icon";
import { sendJson } from "@/lib/api-client";
import type { OutboxItem } from "@/lib/outbox";

// One draft: who it's for, how much, when it goes, and exactly what the client will read.
// Approving records the decision; nothing is sent from here.

const TIER_LABELS: Record<OutboxItem["tier"], string> = {
  courtesy: "Courtesy",
  tier1: "Friendly reminder · Tier 1",
  tier2: "Firm reminder · Tier 2",
  tier3: "Final notice · Tier 3",
  maintenance: "Maintenance heads-up",
  auto_pay_approval: "Auto-pay approval",
  hold_approval: "Hold approval",
  agreement_request: "Agreement to sign",
  agreement_signed_copy: "Signed agreement copy",
  final_demand: "Final demand letter",
};

/** Emails whose wording is fixed and checked against facts: they can be skipped, not edited. */
const FIXED_TEXT_KINDS: ReadonlySet<string> = new Set([
  "final_demand",
  "agreement_request",
  "agreement_signed_copy",
]);

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const FIELD_NAMES: Record<string, string> = {
  subject: "Subject",
  body: "Message",
  at: "New send time",
};

const SEND_LABEL: Record<OutboxItem["tab"], string> = {
  waiting: "Sends after approval",
  scheduled: "Sends",
  sent: "Sent",
  skipped: "",
};

const HOLD_TEXT: Record<NonNullable<OutboxItem["blockedReason"]>, string> = {
  gmail_disconnected:
    "Held: Gmail isn't connected. Reconnect it in Settings > Integrations and this goes out.",
  not_allowlisted:
    "Held: this client's address isn't in DEV_EMAIL_ALLOWLIST, so a dev send is refused.",
  draft_invalid: "Held: this draft failed its checks, so it can't be sent. Stop this send.",
  no_pay_link: "Held: this draft doesn't carry the invoice's pay link. Stop this send.",
  paused: "Held: this schedule is paused or snoozed. It goes out when that ends.",
  on_hold: "Held: the client replied, so this invoice is on hold until you decide.",
  send_failed: "Gmail refused this send. It will try again shortly.",
  pdf_failed: "Held: the invoice PDF couldn't be made. It will try again shortly.",
  archive_failed:
    "Held: the invoice PDF couldn't be saved to your archive folder, and nothing goes without a copy. Check the folder shown in Settings, and it will try again.",
  unknown_outcome:
    "We couldn't confirm this went out. Check your Sent mail in Gmail, then send it again or stop it.",
};

type Mode = "view" | "edit" | "reschedule";

const windowText = ({ days, start, end }: OutboxItem["window"]): string =>
  `${days.map((day) => WEEKDAYS[day - 1] ?? "").join(" ")}, ${start} to ${end}`;

type Act = (payload: object) => Promise<boolean>;

const useDraftAction = (id: string) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act: Act = async (payload) => {
    setBusy(true);
    setError(undefined);
    const result = await sendJson(`/api/outbox/${id}`, "POST", payload, FIELD_NAMES);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    router.refresh();
    return true;
  };
  return { busy, error, act };
};

/** The invoice number inside "Website · Build · FPR-000042 · Installment 2 of 3". */
const invoiceNumberOf = (what: string): string | undefined =>
  what.split(" · ").find((part) => /^[A-Z]{2,}-\d+$/.test(part));

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Bold the invoice number and amount, in the preview only: the email itself is never changed. */
const highlight = (text: string, terms: (string | undefined)[]): ReactNode[] => {
  const found = terms.filter((term): term is string => Boolean(term));
  if (found.length === 0) return [text];
  const pattern = new RegExp(`(${found.map(escapeRegExp).join("|")})`, "g");
  return text.split(pattern).map((part, index) =>
    found.includes(part) ? (
      <strong className="hl" key={index}>
        {part}
      </strong>
    ) : (
      part
    ),
  );
};

const domainOf = (link: string): string => {
  try {
    return new URL(link).hostname;
  } catch {
    return link;
  }
};

/** The pay link as a card of its own, so it's plain what the client taps. */
const PayLinkCard = ({ item, link }: { item: OutboxItem; link: string }) => {
  const number = invoiceNumberOf(item.what);
  return (
    <a className="paylink" href={link} target="_blank" rel="noreferrer">
      <span className="paylink-tile" aria-hidden="true">
        P
      </span>
      <span className="paylink-text">
        <strong>PayPal pay link</strong>
        <span className="muted">
          {number ? `Invoice ${number} · ` : ""}
          {item.amountDue}
        </span>
      </span>
      <span className="paylink-domain">
        {domainOf(link)}
        <Icon name="external" size={16} />
      </span>
    </a>
  );
};

const Message = ({ item }: { item: OutboxItem }) =>
  item.draft ? (
    <div className="outbox-body email-card">
      <div className="outbox-meta email-head">
        <span className="outbox-subject">{item.threadSubject ?? item.draft.subject}</span>
        <span className="chip chip-tier">{TIER_LABELS[item.tier]}</span>
      </div>
      <p className="email-text">
        {highlight(item.draft.body, [invoiceNumberOf(item.what), item.amountDue])}
      </p>
      {item.payLink ? <PayLinkCard item={item} link={item.payLink} /> : null}
    </div>
  ) : (
    <p className="banner banner-warning">
      This draft failed its checks, so it can&apos;t be sent. Skip it; the next reminder gets a new
      draft.
    </p>
  );

const Notes = ({ item }: { item: OutboxItem }) => {
  const { draft, approvedVia } = item;
  return (
    <>
      {draft?.notLegalAdvice ? (
        <p className="field-hint">
          A final notice is not legal advice. Read it closely before you approve it.
        </p>
      ) : null}
      <p className="field-hint">
        {draft?.via === "template" ? "Written from the fixed template." : null}
        {draft?.via === "model" ? `Drafted by ${draft.model ?? "your AI model"}.` : null}
        {draft?.editedAt ? " Edited by you." : null}
        {approvedVia
          ? ` Approved in ${approvedVia === "telegram" ? "Telegram" : "the Outbox"}.`
          : null}
      </p>
    </>
  );
};

const EditForm = ({
  item,
  draft,
  busy,
  act,
  done,
}: {
  item: OutboxItem;
  draft: NonNullable<OutboxItem["draft"]>;
  busy: boolean;
  act: Act;
  done: () => void;
}) => {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (await act({ action: "edit", subject, body })) done();
  };
  return (
    <form
      className="editor-form"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <label htmlFor={`subject-${item.id}`}>Subject</label>
      <input
        id={`subject-${item.id}`}
        value={item.threadSubject ?? subject}
        disabled={item.threadSubject !== null}
        maxLength={200}
        onChange={(event) => {
          setSubject(event.target.value);
        }}
      />
      <label htmlFor={`body-${item.id}`}>Message</label>
      <textarea
        id={`body-${item.id}`}
        rows={12}
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
        }}
      />
      {item.threadSubject ? (
        <p className="field-hint">
          A follow-up keeps the thread&apos;s subject, so it stays on the thread.
        </p>
      ) : null}
      <p className="field-hint">
        Keep the pay link. Links, amounts and legal wording are checked the same way as the
        AI&apos;s.
      </p>
      <div className="actions">
        <button className="button" type="submit" disabled={busy}>
          Save changes
        </button>
        <button className="button button-secondary" type="button" onClick={done}>
          Cancel
        </button>
      </div>
    </form>
  );
};

const RescheduleForm = ({
  item,
  busy,
  act,
  done,
}: {
  item: OutboxItem;
  busy: boolean;
  act: Act;
  done: () => void;
}) => {
  const [at, setAt] = useState(item.sendAtInput);
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (await act({ action: "reschedule", at })) done();
  };
  return (
    <form
      className="editor-form"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <label htmlFor={`at-${item.id}`}>New send time, client time ({item.clientTimeZone})</label>
      <input
        id={`at-${item.id}`}
        type="datetime-local"
        value={at}
        onChange={(event) => {
          setAt(event.target.value);
        }}
      />
      <p className="field-hint">
        Their send window is {windowText(item.window)}. A time outside it moves to the next opening.
      </p>
      <div className="actions">
        <button className="button" type="submit" disabled={busy}>
          Save time
        </button>
        <button className="button button-secondary" type="button" onClick={done}>
          Cancel
        </button>
      </div>
    </form>
  );
};

const Buttons = ({
  item,
  busy,
  act,
  setMode,
}: {
  item: OutboxItem;
  busy: boolean;
  act: Act;
  setMode: (mode: Mode) => void;
}) => {
  const waiting = item.tab === "waiting";
  return (
    <div className="actions">
      {waiting && item.draft ? (
        <>
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => {
              void act({ action: "approve" });
            }}
          >
            <Icon name="mail" />
            Approve and send
          </button>
          {FIXED_TEXT_KINDS.has(item.tier) ? null : (
            <button
              className="button button-secondary"
              type="button"
              onClick={() => {
                setMode("edit");
              }}
            >
              <Icon name="pencil" />
              Edit
            </button>
          )}
        </>
      ) : null}
      {item.blockedReason === "unknown_outcome" ? (
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => {
            void act({ action: "retry_send" });
          }}
        >
          Send again
        </button>
      ) : null}
      {item.draft ? (
        <button
          className="button button-secondary"
          type="button"
          onClick={() => {
            setMode("reschedule");
          }}
        >
          Reschedule
        </button>
      ) : null}
      <button
        className="button button-secondary"
        type="button"
        disabled={busy}
        onClick={() => {
          void act({ action: "skip" });
        }}
      >
        {waiting ? "Skip" : "Stop this send"}
      </button>
    </div>
  );
};

export const OutboxCard = ({ item }: { item: OutboxItem }) => {
  const [mode, setMode] = useState<Mode>("view");
  const { busy, error, act } = useDraftAction(item.id);
  const done = () => {
    setMode("view");
  };
  const open = item.tab === "waiting" || item.tab === "scheduled";
  return (
    <article
      className="card outbox-card outbox-card-open"
      aria-label={`Draft for ${item.clientName}`}
      data-tour="outbox-card"
    >
      <div className="outbox-head">
        <div>
          <h2>{item.clientName}</h2>
          <p className="muted">{item.what}</p>
        </div>
        <div className="money">{item.amountDue}</div>
      </div>
      <p className="outbox-send">
        {item.sendTime ? `${SEND_LABEL[item.tab]}: ${item.sendTime}` : "Skipped: not sent"}
      </p>
      {item.blockedReason ? (
        <p className="banner banner-warning" role="status">
          {HOLD_TEXT[item.blockedReason]}
        </p>
      ) : null}
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      {mode === "edit" && item.draft ? (
        <EditForm item={item} draft={item.draft} busy={busy} act={act} done={done} />
      ) : (
        <Message item={item} />
      )}
      {mode === "reschedule" ? (
        <RescheduleForm item={item} busy={busy} act={act} done={done} />
      ) : null}
      <Notes item={item} />
      {open && mode === "view" ? (
        <Buttons item={item} busy={busy} act={act} setMode={setMode} />
      ) : null}
    </article>
  );
};
