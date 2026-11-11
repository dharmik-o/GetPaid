"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type SyntheticEvent } from "react";
import { buildOptions, LABELS, type BuilderValues } from "@/lib/agreement-form";

// The agreement builder: the clause options on the left, the document as the client will see it
// on the right (a sandboxed iframe with no scripts). The server renders the document and checks
// every option; this screen only collects them. A sent or signed agreement is shown read-only.

export type BuilderAgreement = { id: string; number: string; version: number; status: string };

type Props = {
  projectId: string;
  currency: string;
  agreement: BuilderAgreement | null;
  initial: BuilderValues;
  /** The saved document, shown as it is when the agreement can no longer be edited. */
  savedHtml: string | null;
  countries: { code: string; name: string }[];
};

type Issue = { field: string; message: string };

const readError = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: string; errors?: Issue[] };
    const first = body.errors?.[0];
    if (first) return `${LABELS[first.field] ?? first.field} ${first.message}`;
    return body.error ?? "That didn't work. Try again.";
  } catch {
    return "That didn't work. Check your connection and try again.";
  }
};

const post = (url: string, method: string, body?: unknown): Promise<Response> =>
  fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const AgreementBuilder = ({
  projectId,
  currency,
  agreement,
  initial,
  savedHtml,
  countries,
}: Props) => {
  const router = useRouter();
  const editable = agreement === null || agreement.status === "draft";
  const [values, setValues] = useState(initial);
  const [html, setHtml] = useState<string | null>(savedHtml);
  const [problem, setProblem] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [signName, setSignName] = useState("");

  const set = <K extends keyof BuilderValues>(key: K, value: BuilderValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
  };

  // Live preview: the server renders and checks the options a moment after the last change.
  useEffect(() => {
    if (!editable) return;
    const built = buildOptions(values, currency);
    if (!built.ok) {
      setProblem(built.message);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await post("/api/agreements/preview", "POST", {
            projectId,
            options: built.options,
          });
          if (!response.ok) {
            setProblem(await readError(response));
            return;
          }
          const body = (await response.json()) as { html: string };
          setHtml(body.html);
          setProblem(undefined);
        } catch {
          setProblem("The preview couldn't load. Check your connection.");
        }
      })();
    }, 400);
    return () => {
      clearTimeout(timer);
    };
  }, [values, editable, projectId, currency]);

  const run = async (work: () => Promise<Response>, done: string) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await work();
      if (!response.ok) {
        setProblem(await readError(response));
        return;
      }
      setProblem(undefined);
      setMessage(done);
      router.refresh();
    } catch {
      setProblem("That didn't work. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    const built = buildOptions(values, currency);
    if (!built.ok) {
      setProblem(built.message);
      return;
    }
    void run(
      () =>
        agreement
          ? post(`/api/agreements/${agreement.id}`, "PATCH", { options: built.options })
          : post("/api/agreements", "POST", { projectId, options: built.options }),
      "Draft saved.",
    );
  };

  const number = (key: keyof BuilderValues, label: string, hint?: string) => (
    <div className="field">
      <label htmlFor={`ag-${key}`}>{label}</label>
      <input
        id={`ag-${key}`}
        inputMode="numeric"
        value={String(values[key])}
        onChange={(e) => {
          set(key, e.target.value as never);
        }}
      />
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );

  const checkbox = (key: "confidentiality" | "portfolioUse", label: string) => (
    <div className="field">
      <label>
        <input
          type="checkbox"
          checked={values[key]}
          onChange={(e) => {
            set(key, e.target.checked);
          }}
        />{" "}
        {label}
      </label>
    </div>
  );

  return (
    <div className="agreement-builder">
      {problem ? (
        <div className="banner banner-error" role="alert">
          {problem}
        </div>
      ) : null}
      {message ? (
        <p className="field-hint" role="status">
          {message}
        </p>
      ) : null}
      <p className="muted">
        This is not legal advice. Have a lawyer read the wording before you use it with a client.
      </p>
      {editable ? (
        <form className="form" onSubmit={save} noValidate data-tour="agreement-options">
          {number(
            "depositPercent",
            "Deposit (% of the total)",
            "Due before work starts. 0 for none.",
          )}
          {number("paymentDays", "Days to pay each invoice")}
          {number("revisionRounds", "Rounds of revisions included")}
          {number(
            "acceptanceDays",
            "Days to accept a deliverable",
            "Silence for this long counts as accepted.",
          )}
          {number("killFeePercent", "Cancellation fee (% of the work not yet done)")}
          <div className="field">
            <label htmlFor="ag-ipTransfer">Ownership passes</label>
            <select
              id="ag-ipTransfer"
              value={values.ipTransfer}
              onChange={(e) => {
                set("ipTransfer", e.target.value);
              }}
            >
              <option value="on_full_payment">When the whole project is paid</option>
              <option value="on_each_milestone_payment">As each milestone is paid</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="ag-lateMode">Late payment</label>
            <select
              id="ag-lateMode"
              value={values.lateMode}
              onChange={(e) => {
                set("lateMode", e.target.value as BuilderValues["lateMode"]);
              }}
            >
              <option value="statutory">The law that applies to this client</option>
              <option value="contract_rate">A rate and fee set in this agreement</option>
            </select>
          </div>
          {values.lateMode === "contract_rate" ? (
            <>
              <div className="field">
                <label htmlFor="ag-ratePercent">Monthly interest (%, up to 3)</label>
                <input
                  id="ag-ratePercent"
                  value={values.ratePercent}
                  onChange={(e) => {
                    set("ratePercent", e.target.value);
                  }}
                />
              </div>
              <div className="field">
                <label htmlFor="ag-fixedFee">Fixed late fee ({currency})</label>
                <input
                  id="ag-fixedFee"
                  value={values.fixedFee}
                  onChange={(e) => {
                    set("fixedFee", e.target.value);
                  }}
                />
              </div>
            </>
          ) : null}
          <div className="field">
            <label htmlFor="ag-country">Country whose law governs the agreement</label>
            <select
              id="ag-country"
              value={values.governingLawCountry}
              onChange={(e) => {
                set("governingLawCountry", e.target.value);
              }}
            >
              <option value="">Pick a country</option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {checkbox(
            "confidentiality",
            "Both sides keep each other's business information confidential",
          )}
          {checkbox("portfolioUse", "I may show the finished work in my portfolio")}
          <div className="actions">
            <button className="button" type="submit" disabled={busy}>
              {agreement ? "Save draft" : "Create draft"}
            </button>
            {agreement ? (
              <button
                className="button button-secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  void run(() => post(`/api/agreements/${agreement.id}/void`, "POST"), "Voided.");
                }}
              >
                Void this draft
              </button>
            ) : null}
          </div>
          {agreement ? (
            <div className="field" data-tour="agreement-send">
              <label htmlFor="ag-signName">Send for signature</label>
              <input
                id="ag-signName"
                value={signName}
                placeholder="Your full name"
                maxLength={160}
                onChange={(e) => {
                  setSignName(e.target.value);
                }}
              />
              <div className="field-hint">
                Typing your name signs the agreement for you. This sends the saved draft, so save
                first. The document is then frozen, and an email with the signing link waits in your
                Outbox. Nothing goes to the client until you approve that email.
              </div>
              <button
                className="button"
                type="button"
                disabled={busy || signName.trim().length < 2}
                onClick={() => {
                  void run(
                    () =>
                      post(`/api/agreements/${agreement.id}/send`, "POST", {
                        freelancerSignedName: signName,
                      }),
                    "Sent to your Outbox. Approve the email there to send it to the client.",
                  );
                }}
              >
                Send for signature
              </button>
            </div>
          ) : null}
        </form>
      ) : (
        <div className="actions">
          {agreement.status === "sent" ? (
            <button
              className="button button-secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                void run(() => post(`/api/agreements/${agreement.id}/void`, "POST"), "Voided.");
              }}
            >
              Void
            </button>
          ) : null}
          {agreement.status !== "signed" ? (
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => {
                void run(
                  () => post(`/api/agreements/${agreement.id}/new-version`, "POST"),
                  "New draft version made.",
                );
              }}
            >
              New version
            </button>
          ) : null}
        </div>
      )}
      {html ? (
        <iframe
          title="Agreement preview"
          sandbox=""
          srcDoc={html}
          className="template-preview"
          data-tour="agreement-preview"
        />
      ) : (
        <p className="muted">The preview appears here once the options are valid.</p>
      )}
    </div>
  );
};
