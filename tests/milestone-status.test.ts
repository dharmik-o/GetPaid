import { describe, expect, it } from "vitest";
import {
  canMarkManually,
  hasInvoice,
  MILESTONE_STATUSES,
  statusLabel,
} from "@/lib/milestone-status";

describe("milestone lifecycle", () => {
  it("has exactly the spec's statuses", () => {
    expect(MILESTONE_STATUSES).toEqual([
      "planned",
      "in_progress",
      "delivered",
      "accepted",
      "invoiced",
      "paid",
      "partially_paid",
      "overdue",
      "disputed",
    ]);
    expect(MILESTONE_STATUSES.map(statusLabel)).toEqual([
      "Planned",
      "In progress",
      "Delivered",
      "Accepted",
      "Invoiced",
      "Paid",
      "Partially paid",
      "Overdue",
      "Disputed",
    ]);
  });

  it("lets the freelancer move work forward: planned, in progress, delivered, accepted", () => {
    expect(canMarkManually("planned", "in_progress")).toBe(true);
    expect(canMarkManually("in_progress", "delivered")).toBe(true);
    expect(canMarkManually("delivered", "accepted")).toBe(true);
  });

  it("lets delivered work go back to in progress when the client asks for changes", () => {
    expect(canMarkManually("delivered", "in_progress")).toBe(true);
  });

  it("never lets a person set money statuses; those come from PayPal", () => {
    for (const to of ["invoiced", "paid", "partially_paid", "overdue", "disputed"] as const) {
      expect(canMarkManually("accepted", to), to).toBe(false);
    }
  });

  it("doesn't skip steps or move invoiced work back", () => {
    expect(canMarkManually("planned", "delivered")).toBe(false);
    expect(canMarkManually("invoiced", "in_progress")).toBe(false);
    expect(canMarkManually("paid", "planned")).toBe(false);
  });

  it("knows which statuses mean an invoice exists", () => {
    expect(MILESTONE_STATUSES.filter(hasInvoice)).toEqual([
      "invoiced",
      "paid",
      "partially_paid",
      "overdue",
      "disputed",
    ]);
  });
});
