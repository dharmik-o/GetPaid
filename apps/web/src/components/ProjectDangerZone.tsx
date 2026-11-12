"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Icon } from "@/components/Icon";
import { sendJson } from "@/lib/api-client";
import type { OpenItems } from "@/lib/project-delete";

// The bottom of a project page: archive (hide it, keep every record) or delete it for good.
// Deleting asks for the project's name, and lists what is still open in PayPal first.

type Props = { projectId: string; title: string; archived: boolean; open: OpenItems };

const FIELD_NAMES = { confirmName: "Project name", cancelOpen: "Cancel them in PayPal too" };

export const ProjectDangerZone = ({ projectId, title, archived, open }: Props) => {
  const router = useRouter();
  const id = useId();
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const anyOpen = open.invoices.length > 0 || open.holds.length > 0;
  const ready = typed === title && (!anyOpen || cancelOpen);

  const setArchived = async (next: boolean) => {
    setBusy(true);
    setProblem(undefined);
    const result = await sendJson(
      `/api/projects/${projectId}/${next ? "archive" : "restore"}`,
      "POST",
      {},
      {},
    );
    setBusy(false);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    router.refresh();
  };

  const remove = async () => {
    setBusy(true);
    setProblem(undefined);
    const result = await sendJson(
      `/api/projects/${projectId}`,
      "DELETE",
      { confirmName: typed, ...(anyOpen ? { cancelOpen } : {}) },
      FIELD_NAMES,
    );
    setBusy(false);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    router.push("/projects");
    router.refresh();
  };

  return (
    <section className="card" aria-labelledby="danger">
      <h2 id="danger">Danger zone</h2>
      <div>
        <h3>{archived ? "Restore project" : "Archive project"}</h3>
        <p className="muted">
          {archived
            ? "This project is archived: hidden from lists and Home, with its reminders stopped. Restoring shows it again; reminders are planned afresh."
            : "Hides the project from lists and Home and stops its reminders. Every record stays, and you can restore it."}
        </p>
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => void setArchived(!archived)}
        >
          {archived ? "Restore project" : "Archive project"}
        </button>
      </div>
      <div>
        <h3>Delete project</h3>
        <p className="muted">
          Removes the project for good, with its milestones, invoices, reminders, agreements, holds
          and calendar items. Invoice PDFs already saved in your archive folder stay on disk.
        </p>
        {deleting ? (
          <div className="editor-form" role="group" aria-label="Delete this project">
            {anyOpen ? (
              <>
                <p>
                  Still open:{" "}
                  {[
                    ...(open.invoices.length > 0
                      ? [`unpaid invoices ${open.invoices.map((i) => i.label).join("; ")}`]
                      : []),
                    ...(open.holds.length > 0
                      ? [`open holds on ${open.holds.map((h) => h.name).join("; ")}`]
                      : []),
                  ].join(". ")}
                  .
                </p>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={cancelOpen}
                    onChange={(event) => {
                      setCancelOpen(event.target.checked);
                    }}
                  />
                  <span>Cancel them in PayPal too</span>
                </label>
                <p className="field-hint">
                  Invoices are cancelled and holds voided first. If PayPal refuses any, nothing is
                  deleted.
                </p>
              </>
            ) : null}
            <label htmlFor={`${id}-name`}>Type the project name to confirm: {title}</label>
            <input
              id={`${id}-name`}
              autoComplete="off"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
            {problem ? (
              <p className="banner banner-error" role="alert">
                {problem}
              </p>
            ) : null}
            <div className="actions">
              <button
                className="button button-danger"
                type="button"
                disabled={busy || !ready}
                onClick={() => void remove()}
              >
                <Icon name="ban" />
                {busy ? "Deleting…" : "Delete this project for good"}
              </button>
              <button
                className="button button-secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setDeleting(false);
                  setTyped("");
                  setProblem(undefined);
                }}
              >
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <button
            className="button button-danger"
            type="button"
            onClick={() => {
              setDeleting(true);
            }}
          >
            <Icon name="ban" />
            Delete project
          </button>
        )}
      </div>
      {!deleting && problem ? (
        <p className="banner banner-error" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
};
