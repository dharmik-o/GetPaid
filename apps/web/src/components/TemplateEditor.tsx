"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LIST_SECTIONS, TAG_GROUPS } from "@/lib/template-tags";

// The template editor: HTML and CSS side by side, a live preview with sample data, a tag list
// to click and insert, and the sanitiser's notes inline. The preview is a sandboxed iframe with
// no scripts; the server sanitises again on every save. Built-ins open read-only.

export type EditableTemplate = {
  id: string | null;
  name: string;
  kind: "builtin" | "custom";
  html: string;
  css: string;
};

type Preview = {
  document: string | null;
  removed: string[];
  refused: string[];
  tagIssues: { line: number; message: string }[];
};

type Issue = { field: string; message: string };

const PREVIEW_DELAY_MS = 400;

const LISTS = Object.entries(LIST_SECTIONS).map(([list, tags]) => ({
  group: list === "items" ? "Line items (repeat)" : "Installment schedule (repeat)",
  open: `{{#${list}}}`,
  close: `{{/${list}}}`,
  tags,
}));

export const TemplateEditor = ({ initial }: { initial: EditableTemplate }) => {
  const router = useRouter();
  const readOnly = initial.kind === "builtin";
  const [name, setName] = useState(initial.name);
  const [html, setHtml] = useState(initial.html);
  const [css, setCss] = useState(initial.css);
  const [preview, setPreview] = useState<Preview>();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const [busy, setBusy] = useState(false);
  const htmlBox = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetch("/api/invoice-templates/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ html, css }),
      })
        .then(async (response) => {
          if (response.ok) setPreview((await response.json()) as Preview);
        })
        .catch(() => {
          setPreview(undefined);
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [html, css]);

  const insert = (text: string) => {
    const box = htmlBox.current;
    const start = box?.selectionStart ?? html.length;
    const end = box?.selectionEnd ?? html.length;
    setHtml(`${html.slice(0, start)}${text}${html.slice(end)}`);
    requestAnimationFrame(() => {
      box?.focus();
      box?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const request = async (url: string, method: string, body?: unknown) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json =
        response.status === 204
          ? {}
          : ((await response.json()) as {
              template?: { id: string };
              removed?: string[];
              errors?: Issue[];
              error?: string;
            });
      return { ok: response.ok, json };
    } catch {
      return {
        ok: false,
        json: { error: "That didn't reach the server. Check your connection and try again." },
      };
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const isNew = initial.id === null;
    const { ok, json } = await request(
      isNew ? "/api/invoice-templates" : `/api/invoice-templates/${initial.id ?? ""}`,
      isNew ? "POST" : "PUT",
      { name, html, css },
    );
    setIssues(json.errors ?? []);
    if (!ok) {
      setMessage({ text: json.error ?? "That didn't save. Try again.", error: true });
      return;
    }
    const removed = json.removed ?? [];
    setMessage({
      text: removed.length > 0 ? `Saved. Removed for safety: ${removed.join("; ")}.` : "Saved.",
      error: false,
    });
    if (isNew && json.template) router.push(`/settings/templates/${json.template.id}`);
    router.refresh();
  };

  const duplicate = async () => {
    const { ok, json } = await request("/api/invoice-templates", "POST", {
      duplicateOf: initial.id,
    });
    if (ok && json.template) {
      router.push(`/settings/templates/${json.template.id}`);
      return;
    }
    setMessage({ text: json.error ?? "That didn't copy. Try again.", error: true });
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${name}? Invoices that used it switch to your default template.`))
      return;
    const { ok, json } = await request(`/api/invoice-templates/${initial.id ?? ""}`, "DELETE");
    if (ok) {
      router.push("/settings/templates");
      router.refresh();
      return;
    }
    setMessage({ text: json.error ?? "That didn't delete. Try again.", error: true });
  };

  const notes = [
    ...(preview?.refused ?? []).map((text) => ({ text: `Can't save: ${text}`, error: true })),
    ...(preview?.tagIssues ?? []).map((i) => ({
      text: `Line ${String(i.line)}: ${i.message}`,
      error: true,
    })),
    ...(preview?.removed ?? []).map((text) => ({ text: `Will be removed: ${text}`, error: false })),
  ];

  return (
    <div className="editor-form">
      {readOnly ? (
        <div className="banner" role="status">
          Built-in templates can&apos;t be changed.{" "}
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => void duplicate()}
          >
            Duplicate it to edit a copy
          </button>
        </div>
      ) : null}
      <label htmlFor="template-name">Name</label>
      <input
        id="template-name"
        value={name}
        maxLength={80}
        readOnly={readOnly}
        onChange={(e) => {
          setName(e.target.value);
        }}
      />
      <div className="editor-grid">
        <div>
          <label htmlFor="template-html">HTML</label>
          <textarea
            id="template-html"
            ref={htmlBox}
            className="code-box"
            rows={22}
            spellCheck={false}
            readOnly={readOnly}
            value={html}
            aria-describedby="template-notes"
            onChange={(e) => {
              setHtml(e.target.value);
            }}
          />
          <label htmlFor="template-css">CSS</label>
          <textarea
            id="template-css"
            className="code-box"
            rows={12}
            spellCheck={false}
            readOnly={readOnly}
            value={css}
            onChange={(e) => {
              setCss(e.target.value);
            }}
          />
        </div>
        <div>
          <span className="field-hint">Preview with sample data</span>
          {preview?.document ? (
            <iframe
              title="Template preview"
              sandbox=""
              srcDoc={preview.document}
              className="template-preview"
            />
          ) : (
            <p className="empty">The preview shows here once every tag is one the app fills in.</p>
          )}
        </div>
      </div>
      <ul id="template-notes" className="template-notes" aria-live="polite">
        {[...issues.map((i) => ({ text: i.message, error: true })), ...notes].map((note) => (
          <li key={note.text} className={note.error ? "field-error" : "field-hint"}>
            {note.text}
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <details className="details" open>
          <summary>Tags (click to insert at the cursor)</summary>
          {TAG_GROUPS.map(({ group, tags }) => (
            <div key={group} className="tag-list">
              <span className="field-hint">{group}</span>
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="chip"
                  onClick={() => {
                    insert(`{{${tag}}}`);
                  }}
                >
                  {`{{${tag}}}`}
                </button>
              ))}
            </div>
          ))}
          {LISTS.map((list) => (
            <div key={list.group} className="tag-list">
              <span className="field-hint">{list.group}</span>
              <button
                type="button"
                className="chip"
                onClick={() => {
                  insert(`${list.open}${list.tags.map((t) => `{{${t}}}`).join(" ")}${list.close}`);
                }}
              >
                {`${list.open} … ${list.close}`}
              </button>
              {list.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="chip"
                  onClick={() => {
                    insert(`{{${tag}}}`);
                  }}
                >
                  {`{{${tag}}}`}
                </button>
              ))}
            </div>
          ))}
        </details>
      )}
      {readOnly ? null : (
        <div className="actions">
          <button className="button" type="button" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save template"}
          </button>
          {initial.id ? null : (
            <Link className="button button-secondary" href="/settings/templates">
              Cancel
            </Link>
          )}
          {initial.id ? (
            <button
              className="button button-danger"
              type="button"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete
            </button>
          ) : null}
        </div>
      )}
      {message ? (
        <div className={message.error ? "banner banner-error" : "banner"} role="status">
          {message.text}
        </div>
      ) : null}
    </div>
  );
};
