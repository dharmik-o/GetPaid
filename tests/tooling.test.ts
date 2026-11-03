import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REQUIRED_SCRIPTS = [
  "dev",
  "test",
  "test:e2e",
  "lint",
  "typecheck",
  "check",
  "db:migrate",
  "db:seed",
] as const;

const readScripts = (): Record<string, string> => {
  const raw = readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8");
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
};

describe("root package.json scripts", () => {
  const scripts = readScripts();

  it.each(REQUIRED_SCRIPTS)("defines %s", (name) => {
    expect(scripts[name], `missing script "${name}"`).toBeTruthy();
  });

  it.each(REQUIRED_SCRIPTS)("%s is not a placeholder", (name) => {
    const command = scripts[name] ?? "";
    expect(command).not.toMatch(/TODO/i);
    expect(command).not.toMatch(/exit 1/);
  });

  it("check runs lint, typecheck and test", () => {
    expect(scripts.check).toMatch(/lint.*typecheck.*test/);
  });
});
