"use client";

import { useState } from "react";

// "Test connection": runs the 4 sample tasks (fake data) on the saved models and shows pass or
// fail for each, with the model that answered and what to check when one fails.

export type TestRow = {
  task: string;
  pass: boolean;
  model: string | null;
  isLocal: boolean | null;
  detail: string;
};

export const AiTestPanel = ({ hasSettings }: { hasSettings: boolean }) => {
  const [results, setResults] = useState<TestRow[]>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();

  const run = async () => {
    setRunning(true);
    setError(undefined);
    setResults(undefined);
    try {
      const response = await fetch("/api/ai/test", { method: "POST" });
      const body = (await response.json()) as { results?: TestRow[]; error?: string };
      if (!response.ok || !body.results) {
        setError(body.error ?? "The test didn't run. Try again.");
        return;
      }
      setResults(body.results);
    } catch {
      setError("That didn't reach the server. Check your connection and try again.");
    } finally {
      setRunning(false);
    }
  };

  const passed = results?.filter((r) => r.pass).length ?? 0;

  return (
    <div>
      <p className="field-hint">
        Sorts 2 sample replies and drafts a Tier 1 and a Tier 2 email, using made-up data only. A
        local model can take a minute.
      </p>
      <button
        type="button"
        className="button"
        disabled={running || !hasSettings}
        onClick={() => void run()}
      >
        {running ? "Testing…" : "Test connection"}
      </button>
      {hasSettings ? null : <p className="muted">Save a model above first.</p>}
      {running ? (
        <p role="status" className="muted">
          Running 4 sample tasks…
        </p>
      ) : null}
      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}
      {results ? (
        <>
          <p role="status">
            {passed} of {results.length} passed.
          </p>
          <table className="table table-stack">
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Result</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {results.map((row) => (
                <tr key={row.task}>
                  <td data-label="Task">{row.task}</td>
                  <td data-label="Result">
                    <span className={row.pass ? "chip" : "badge badge-overdue"}>
                      {row.pass ? "Pass" : "Fail"}
                    </span>
                  </td>
                  <td data-label="Details">{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
};
