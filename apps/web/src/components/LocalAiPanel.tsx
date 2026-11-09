"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type SyntheticEvent } from "react";
import type { LocalAiStatus, PullJob } from "@/lib/local-ai";

// Settings > AI: is the local model runner on, and which models does it have? Downloads start
// here and run on the runner; this page only polls their progress. Off in demo mode.

type Props = {
  status: LocalAiStatus;
  suggested: readonly { name: string; size: string }[];
  demo: boolean;
};

const percent = (job: PullJob): string =>
  job.total > 0 ? ` ${String(Math.floor((job.completed / job.total) * 100))}%` : "";

export const LocalAiPanel = ({ status, suggested, demo }: Props) => {
  const router = useRouter();
  const [model, setModel] = useState("");
  const [job, setJob] = useState<PullJob>();
  const [error, setError] = useState<string>();
  const pulling = job?.state === "pulling";

  useEffect(() => {
    if (!pulling) return;
    const timer = setInterval(() => {
      void fetch("/api/settings/ai/local-models/pull")
        .then((response) => response.json() as Promise<{ job: PullJob | null }>)
        .then(({ job: next }) => {
          if (!next) return;
          setJob(next);
          if (next.state === "done") router.refresh();
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [pulling, router]);

  const download = async (name: string, event?: SyntheticEvent) => {
    event?.preventDefault();
    setError(undefined);
    try {
      const response = await fetch("/api/settings/ai/local-models/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: name.trim() }),
      });
      const result = (await response.json()) as { job?: PullJob; error?: string };
      if (!response.ok || !result.job) {
        setError(result.error ?? "The download didn't start. Try again.");
        return;
      }
      setJob(result.job);
    } catch {
      setError("That didn't reach the server. Check your connection and try again.");
    }
  };

  if (!status.up) {
    return (
      <p className="field-hint">
        {demo
          ? "Local AI is not available on this demo. Pick a cloud model instead."
          : "Local AI is off. To use it, run `npm run local-ai:on` (downloads about 1.5 GB once). Or pick a cloud model instead; you don't need local AI."}
      </p>
    );
  }

  return (
    <div className="form-wide">
      <p>
        Local AI is on.{" "}
        {status.models.length > 0
          ? `Downloaded: ${status.models.join(", ")}.`
          : "No models downloaded yet."}
      </p>
      {demo ? null : (
        <>
          <div className="actions">
            {suggested.map((item) => (
              <button
                key={item.name}
                type="button"
                className="button button-secondary"
                disabled={pulling}
                onClick={() => void download(item.name)}
              >
                Download {item.name} ({item.size})
              </button>
            ))}
          </div>
          <form className="field" onSubmit={(event) => void download(model, event)}>
            <label htmlFor="local-model-name">Or another model</label>
            <input
              id="local-model-name"
              value={model}
              placeholder="for example phi3:mini"
              onChange={(e) => {
                setModel(e.target.value);
              }}
            />
            <button type="submit" className="button" disabled={pulling || model.trim() === ""}>
              Download
            </button>
          </form>
        </>
      )}
      {job ? (
        <div className={job.state === "failed" ? "banner banner-error" : "banner"} role="status">
          {job.model}: {job.message}
          {pulling ? percent(job) : ""}
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
};
