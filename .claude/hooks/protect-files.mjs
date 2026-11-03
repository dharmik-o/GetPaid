// Blocks edits to secrets, git internals and lock files, and shell commands that touch real .env files.
// Exit code 2 = blocked; the message on stderr is shown to Claude.
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const tool = input.tool_name;
const args = input.tool_input || {};

const block = (why) => { process.stderr.write(`Blocked by protect-files hook: ${why}\n`); process.exit(2); };

// .env, .env.local, .env.production ... but NOT .env.example
const realEnv = /(^|[\/\\\s"'=])\.env(?!\.example)(\.[\w-]+)?($|[\s"'\/\;|&)])/;

if (tool === "Edit" || tool === "Write") {
  const p = String(args.file_path || "").replace(/\\/g, "/");
  if (realEnv.test(p)) block(`${p} holds secrets. Edit .env.example instead and tell the user which value to add.`);
  if (p.includes("/.git/")) block("never edit files inside .git/");
  if (/(^|\/)package-lock\.json$/.test(p)) block("let npm update package-lock.json; don't edit it by hand");
  if (/\.(pem|key)$/.test(p)) block("never write key files");
}

if (tool === "Bash") {
  const cmd = String(args.command || "");
  if (realEnv.test(cmd)) block("this command touches a real .env file. Use process.env in code, or ask the user to check the value.");
  if (/api-m\.paypal\.com(?!.*sandbox)/.test(cmd) && !cmd.includes("api-m.sandbox.paypal.com")) block("live PayPal endpoint. Use api-m.sandbox.paypal.com only.");
}
process.exit(0);
