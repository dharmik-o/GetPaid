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
// "standalone" makes `next build` write a small self-contained server for the production container.
// The public signing pages: no search indexing, no framing, and nothing loaded from outside this
// site. The inline allowances are Next.js's own bootstrap scripts and styles; the agreement itself
// is shown in a sandboxed frame that can run no script. Dev mode also needs eval for hot reload.
const signingCsp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const nextConfig = {
  agentRules: false,
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  headers: async () => [
    {
      source: "/sign/:path*",
      headers: [
        { key: "Content-Security-Policy", value: signingCsp },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    },
  ],
};

export default nextConfig;
