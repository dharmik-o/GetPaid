import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mainSteps, TIPS } from "@/lib/tour-steps";

// Every tour target must be a `data-tour` attribute somewhere in the app, or the step can never
// point at anything.

const SRC = join(import.meta.dirname, "..", "apps", "web", "src");

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [readFileSync(path, "utf8")] : [];
  });

describe("the guided tour", () => {
  const code = sources(SRC).join("\n");
  const targets = [
    ...mainSteps("00000000-0000-4000-8000-0000000000d1"),
    ...Object.values(TIPS).flat(),
  ].flatMap((step) => (step.target ? [step.target] : []));

  it.each(targets)("finds data-tour=%s in the app", (target) => {
    // Either data-tour="x", or an expression that can give "x" (data-tour={... "x" ...}).
    const literal = code.includes(`data-tour="${target}"`);
    const expression = new RegExp(`data-tour=\\{[^}]*"${target}"`).test(code);
    expect(literal || expression).toBe(true);
  });

  it("shows how to close an invoice paid outside PayPal, right after milestones", () => {
    const steps = mainSteps("p1");
    const at = steps.findIndex((step) => step.target === "record-payment");
    expect(steps[at - 1]?.target).toBe("milestone-card");
    expect(steps[at]?.body).toMatch(/bank transfer, UPI, cash, cheque/);
    expect(TIPS.project.some((step) => step.target === "record-payment")).toBe(true);
  });
});
