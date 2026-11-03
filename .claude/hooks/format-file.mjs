// Formats the file Claude just edited with Prettier, if Prettier is installed. Never blocks.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const file = input.tool_input?.file_path;
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const prettier = join(root, "node_modules", ".bin", process.platform === "win32" ? "prettier.cmd" : "prettier");
  if (file && existsSync(prettier) && /\.(ts|tsx|js|mjs|json|md|css|sql|ya?ml)$/.test(file)) {
    spawnSync(prettier, ["--write", "--ignore-unknown", file], { stdio: "ignore", shell: process.platform === "win32" });
  }
} catch { /* formatting is best effort */ }
process.exit(0);
