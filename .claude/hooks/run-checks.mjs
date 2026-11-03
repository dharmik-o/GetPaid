// Runs `npm run check` (lint + typecheck + tests) before Claude finishes a turn.
// If checks fail, exit 2 sends the failure back to Claude so it keeps fixing instead of stopping.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
if (input.stop_hook_active) process.exit(0); // already sent Claude back once; avoid loops

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
if (!existsSync(join(root, "node_modules"))) process.exit(0); // nothing installed yet (M0)

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!pkg.scripts?.check) process.exit(0);

const run = spawnSync("npm", ["run", "check", "--silent"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
if (run.status !== 0) {
  const out = `${run.stdout || ""}\n${run.stderr || ""}`.trim().split("\n").slice(-60).join("\n");
  process.stderr.write(`npm run check failed. Fix the cause (don't skip or weaken tests), then finish.\n\n${out}\n`);
  process.exit(2);
}
process.exit(0);
