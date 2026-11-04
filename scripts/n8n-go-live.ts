import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  forThisInstance,
  GO_LIVE_WORKFLOWS,
  parseCliJson,
  workflowIdByName,
  type WorkflowFile,
} from "./lib/n8n-go-live";

// `npm run n8n:go-live`, which you run yourself: updates "Approval handler" to the repo's version
// (it needs the maintenance card), publishes it, Scheduler and Reply listener, and restarts n8n.
// `-- --dry-run` only reads and says what it would do. It never prints credentials: it asks n8n for
// their names, types and ids only, and throws away the rest.

const dryRun = process.argv.includes("--dry-run");
const CONTAINER_FILE = "/tmp/approval-handler.json";
const APPROVAL_FILE = resolve("n8n/workflows/03_approval_handler.json");

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** docker compose, quietly: its output can hold more than should reach a terminal. */
const compose = (...args: string[]): string =>
  execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    // Git Bash would otherwise rewrite the container paths.
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });

const n8n = (...args: string[]): string => compose("exec", "-T", "n8n", "n8n", ...args);

const workflowsSchema = z.array(
  z.object({ id: z.string(), name: z.string(), active: z.boolean() }),
);
const credentialsSchema = z.array(z.object({ id: z.string(), name: z.string(), type: z.string() }));

const listWorkflows = () => workflowsSchema.parse(parseCliJson(n8n("export:workflow", "--all")));

const report = (): void => {
  for (const workflow of listWorkflows()) {
    say(`  ${workflow.active ? "active  " : "inactive"} ${workflow.name.split(":")[0] ?? ""}`);
  }
};

const main = (): void => {
  const workflows = listWorkflows();
  const credentials = credentialsSchema.parse(parseCliJson(n8n("export:credentials", "--all")));
  const ids = GO_LIVE_WORKFLOWS.map((name) => ({ name, id: workflowIdByName(workflows, name) }));
  const approvalId = ids[0]?.id ?? "";
  const file = JSON.parse(readFileSync(APPROVAL_FILE, "utf8")) as WorkflowFile;
  const updated = forThisInstance(file, approvalId, credentials);

  if (dryRun) {
    say("Dry run. Nothing changed. It would:");
    say(`  update Approval handler (${String(updated.nodes.length)} nodes) in place`);
    for (const { name } of ids) say(`  publish ${name}`);
    say("  restart n8n");
    say("Now:");
    report();
    return;
  }

  const folder = mkdtempSync(join(tmpdir(), "n8n-go-live-"));
  try {
    const local = join(folder, "approval-handler.json");
    writeFileSync(local, JSON.stringify([updated]));
    compose("cp", local, `n8n:${CONTAINER_FILE}`);
    n8n("import:workflow", `--input=${CONTAINER_FILE}`);
    say("Updated Approval handler.");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  for (const { name, id } of ids) {
    n8n("publish:workflow", `--id=${id}`);
    say(`Published ${name}.`);
  }
  say("Restarting n8n, which takes about a minute...");
  compose("restart", "n8n");
  say("Done. n8n says:");
  report();
};

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
