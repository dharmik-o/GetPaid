import { describe, expect, it } from "vitest";
import { checkPlan, milestoneCents, type PlanItem } from "@/lib/milestone-plan";

const pct = (name: string, percentBp: number, deadline = "2026-12-01"): PlanItem => ({
  name,
  percentBp,
  deadline,
});
const amt = (name: string, amountCents: number, deadline = "2026-12-01"): PlanItem => ({
  name,
  amountCents,
  deadline,
});

describe("milestoneCents", () => {
  it("splits the $3,000 demo project 30 / 50 / 20", () => {
    expect(
      milestoneCents([pct("Design", 3000), pct("Build", 5000), pct("Launch", 2000)], 300000),
    ).toEqual([90000, 150000, 60000]);
  });

  it("splits $1,000 and $100 at 33.33 / 33.33 / 33.34%", () => {
    const thirds = [pct("A", 3333), pct("B", 3333), pct("C", 3334)];
    expect(milestoneCents(thirds, 100000)).toEqual([33330, 33330, 33340]);
    expect(milestoneCents(thirds, 10000)).toEqual([3333, 3333, 3334]);
  });

  it("gives the rounding remainder to the last milestone so the total is exact", () => {
    // $10.00 at 33.33 / 33.33 / 33.34%: 333.3, 333.3 and 333.4 round to 333 each; the last gets 334.
    expect(milestoneCents([pct("A", 3333), pct("B", 3333), pct("C", 3334)], 1000)).toEqual([
      333, 333, 334,
    ]);
    // 100.01 split in halves rounds both up to 50.01; the last gives the extra cent back.
    expect(milestoneCents([pct("A", 5000), pct("B", 5000)], 10001)).toEqual([5001, 5000]);
  });

  it("keeps typed amounts exact in a mixed plan; the last % milestone takes the remainder", () => {
    expect(milestoneCents([pct("A", 3333), amt("B", 500), pct("C", 1667)], 1000)).toEqual([
      333, 500, 167,
    ]);
  });

  it("stays exact for amounts too large for float maths", () => {
    expect(milestoneCents([pct("A", 3333), pct("B", 6667)], 9007199254740991)).toEqual([
      3002099511605172, 6005099743135819,
    ]);
  });
});

describe("checkPlan", () => {
  it("accepts an empty plan: the project is billed as one invoice", () => {
    expect(checkPlan([], 300000, "USD")).toEqual({ errors: [], warnings: [] });
  });

  it("accepts amounts that add up to the project total", () => {
    expect(checkPlan([amt("A", 100000), amt("B", 200000)], 300000, "USD").errors).toEqual([]);
  });

  it("rejects amounts that don't add up, saying by how much", () => {
    const { errors } = checkPlan([amt("A", 100000), amt("B", 190000)], 300000, "USD");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe("milestones");
    expect(errors[0]?.message.replace(/\s/gu, " ")).toBe(
      "Milestones add up to USD 2,900.00, but the project total is USD 3,000.00. Change them so they match.",
    );
  });

  it("accepts percentages that add up to 100% and rejects ones that don't", () => {
    expect(checkPlan([pct("A", 3000), pct("B", 7000)], 300000, "USD").errors).toEqual([]);
    expect(checkPlan([pct("A", 3000), pct("B", 6000)], 300000, "USD").errors).toEqual([
      {
        field: "milestones",
        message:
          "Milestones add up to 90%, but they must add up to 100%. Change them so they match.",
      },
    ]);
  });

  it("accepts a mixed plan only when amounts plus percentages make the exact total", () => {
    // USD 900 + 70% of 3,000 = 3,000.
    expect(checkPlan([amt("A", 90000), pct("B", 7000)], 300000, "USD").errors).toEqual([]);
    expect(checkPlan([amt("A", 90000), pct("B", 6000)], 300000, "USD").errors).toHaveLength(1);
  });

  it("warns, without blocking, when deadlines are out of order", () => {
    const plan = [
      pct("Design", 3000, "2026-12-10"),
      pct("Build", 5000, "2026-12-05"),
      pct("Launch", 2000, "2026-12-20"),
    ];
    expect(checkPlan(plan, 300000, "USD")).toEqual({
      errors: [],
      warnings: [
        {
          field: "milestones.1.deadline",
          message:
            "Build is due (5 Dec) before Design (10 Dec). You can still save; check the order is right.",
        },
      ],
    });
  });
});

describe("checkPlan while a row is still being filled in", () => {
  it("skips the order check for a blank or partial deadline instead of failing", () => {
    const plan = [pct("Design", 3000, "2026-12-10"), pct("Build", 7000, ""), pct("Launch", 0, "2026-1")];
    expect(() => checkPlan(plan, 300000, "USD")).not.toThrow();
    expect(checkPlan(plan, 300000, "USD").warnings).toEqual([]);
  });
});
