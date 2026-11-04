import type { AutoPayFacts, MaintenanceFacts, ReminderFacts } from "@/lib/draft-facts";

// Made-up facts for drafting tests: fake names and a fake sandbox pay link.

export const PAY_LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-TEST-AAAA-BBBB";

export const reminderFacts = (overrides: Partial<ReminderFacts> = {}): ReminderFacts => ({
  freelancerName: "Alex Rivera",
  clientName: "Sam Lee",
  projectTitle: "Website redesign",
  milestoneName: "Build",
  deliverable: "the new website",
  invoiceNumber: "FPR-000042",
  amountDue: "USD 1,500.00",
  dueDate: "31 Oct 2026",
  daysOverdue: 14,
  paymentTerms: "Net 14",
  contractTerms: null,
  installment: null,
  payLink: PAY_LINK,
  citation: null,
  ...overrides,
});

export const APPROVAL_LINK =
  "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-TEST-0001";

export const autoPayFacts = (overrides: Partial<AutoPayFacts> = {}): AutoPayFacts => ({
  freelancerName: "Alex Rivera",
  clientName: "Sam Lee",
  retainerName: "Monthly hosting",
  amount: "USD 200.00",
  repeat: "every month",
  firstCharge: "7 Dec 2026",
  lastCharge: null,
  approvalLink: APPROVAL_LINK,
  ...overrides,
});

export const maintenanceFacts = (overrides: Partial<MaintenanceFacts> = {}): MaintenanceFacts => ({
  freelancerName: "Alex Rivera",
  clientName: "Sam Lee",
  projectTitle: "Website redesign",
  task: "Security updates and backups",
  type: "maintenance",
  dueDate: "15 May 2027",
  estimatedCost: "USD 200.00",
  ...overrides,
});
