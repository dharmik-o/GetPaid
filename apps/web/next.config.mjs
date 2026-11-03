import { existsSync } from "node:fs";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

// Secrets live in one env file at the repo root, shared with docker compose and the db scripts.
// Variables already set in the shell win; nothing is printed.
const rootEnvFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

// The project's agent rules live in CLAUDE.md; don't let `next dev` write an AGENTS.md.
/** @type {import('next').NextConfig} */
const nextConfig = { agentRules: false };

export default nextConfig;
