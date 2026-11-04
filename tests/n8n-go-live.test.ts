import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  forThisInstance,
  parseCliJson,
  workflowIdByName,
  type WorkflowFile,
} from "../scripts/lib/n8n-go-live";

// What `npm run n8n:go-live` does to the Approval handler file before importing it.

const ROOT = join(import.meta.dirname, "..");
const FILE = JSON.parse(
  readFileSync(join(ROOT, "n8n", "workflows", "03_approval_handler.json"), "utf8"),
) as WorkflowFile;

const CREDENTIALS = [
  { id: "real-telegram", name: "Telegram account", type: "telegramApi" },
  { id: "real-header", name: "Header Auth account", type: "httpHeaderAuth" },
];

describe("forThisInstance", () => {
  const updated = forThisInstance(FILE, "workflow-id", CREDENTIALS);

  it("targets the existing workflow, so it updates rather than duplicates", () => {
    expect(updated.id).toBe("workflow-id");
  });

  it("points every node's credentials at this instance, with no placeholder left", () => {
    const text = JSON.stringify(updated);
    expect(text).not.toContain('"telegram-bot"');
    expect(text).not.toContain('"app-internal-api-token"');
    expect(text).toContain("real-telegram");
    expect(text).toContain("real-header");
  });

  it("keeps every node, including the maintenance card", () => {
    expect(updated.nodes).toHaveLength(FILE.nodes.length);
    expect(updated.nodes.map((node) => node.name)).toContain("Send maintenance card");
  });

  it("refuses to guess when a credential type is missing or ambiguous", () => {
    expect(() => forThisInstance(FILE, "x", [])).toThrow("exactly one n8n credential");
    expect(() =>
      forThisInstance(FILE, "x", [...CREDENTIALS, { id: "2", name: "Other", type: "telegramApi" }]),
    ).toThrow("exactly one n8n credential");
  });
});

describe("finding a workflow", () => {
  const WORKFLOWS = [
    { id: "1", name: "Scheduler (hourly): due reminders", active: false },
    { id: "2", name: "Approval handler: cards", active: true },
  ];

  it("goes by the start of the name", () => {
    expect(workflowIdByName(WORKFLOWS, "Scheduler")).toBe("1");
  });

  it("refuses a name it can't find, or finds twice", () => {
    expect(() => workflowIdByName(WORKFLOWS, "Missing")).toThrow("found 0");
    expect(() =>
      workflowIdByName(
        [...WORKFLOWS, { id: "3", name: "Scheduler copy", active: false }],
        "Scheduler",
      ),
    ).toThrow("found 2");
  });
});

describe("reading the CLI", () => {
  it("skips log lines before the JSON", () => {
    expect(parseCliJson('Some log line\n[{"id":"1"}]')).toEqual([{ id: "1" }]);
  });

  it("says what's wrong when there's no list", () => {
    expect(() => parseCliJson("nothing here")).toThrow("no list");
  });
});

describe("the tunnel's policy", () => {
  const policy = readFileSync(join(ROOT, "gateway", "ngrok-policy.yml"), "utf8");

  it("answers 404 for anything outside /webhook/, so the n8n editor isn't exposed", () => {
    expect(policy).toContain("!req.url.path.startsWith('/webhook/')");
    expect(policy).toContain("custom-response");
    expect(policy).toContain("status_code: 404");
  });

  it("also refuses path tricks that could step back out of /webhook/", () => {
    expect(policy).toContain("req.url.path.contains('..')");
    expect(policy).toContain("req.url.path.contains('%')");
  });
});
