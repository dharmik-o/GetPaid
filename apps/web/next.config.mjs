import { existsSync } from "node:fs";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

// Secrets live in one env file at the repo root, shared with docker compose and the db scripts.
// Variables already set in the shell win; nothing is printed.
const rootEnvFile = fileURLToPath(new URL("../../.env", import.meta.url));
// The E2E's server runs on fake values only, and doesn't load it.
if (!process.env.E2E_FAKE_URL && existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

// The project's agent rules live in CLAUDE.md; don't let `next dev` write an AGENTS.md.
/** @type {import('next').NextConfig} */
// NEXT_DIST_DIR gives the E2E's server a build folder of its own, beside your dev server's.
const nextConfig = { agentRules: false, distDir: process.env.NEXT_DIST_DIR ?? ".next" };

export default nextConfig;
