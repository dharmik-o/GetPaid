import type { Draft } from "./ai-schemas";
import type { AutoPayFacts, DraftRequest, MaintenanceFacts, ReminderFacts } from "./draft-facts";

// The fixed fallback for each kind of draft: used when no model gives a valid answer, so a
// reminder still gets a correct draft. Built only from the facts. Pure.

const SUBJECT_MAX = 200;

const subject = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, SUBJECT_MAX);

const days = (n: number): string => `${String(n)} ${n === 1 ? "day" : "days"}`;

const which = (facts: ReminderFacts): string =>
  facts.installment ? `${facts.installment}, ${facts.amountDue}` : facts.amountDue;

const payBlock = (facts: ReminderFacts): string => `You can pay it here:\n${facts.payLink}`;

const letter = (to: string, paragraphs: string[], from: string): string =>
  [`Hi ${to},`, ...paragraphs, `Thanks,\n${from}`].join("\n\n");

const courtesy = (f: ReminderFacts): Draft => ({
  subject: subject(`Payment due soon: ${f.projectTitle} (invoice ${f.invoiceNumber})`),
  body: letter(
    f.clientName,
    [
      `Just a heads-up that invoice ${f.invoiceNumber} for ${f.projectTitle} (${which(f)}) is due on ${f.dueDate}.`,
      payBlock(f),
    ],
    f.freelancerName,
  ),
});

const tier1 = (f: ReminderFacts): Draft => ({
  subject: subject(`Friendly reminder: invoice ${f.invoiceNumber} for ${f.projectTitle}`),
  body: letter(
    f.clientName,
    [
      `I hope ${f.deliverable ?? f.milestoneName} is working well for you. Let me know if anything needs a look.`,
      `A quick reminder that invoice ${f.invoiceNumber} (${which(f)}) was due on ${f.dueDate}.`,
      payBlock(f),
    ],
    f.freelancerName,
  ),
});

const tier2 = (f: ReminderFacts): Draft => ({
  subject: subject(`Overdue: invoice ${f.invoiceNumber} for ${f.projectTitle}`),
  body: letter(
    f.clientName,
    [
      `Invoice ${f.invoiceNumber} (${which(f)}) was due on ${f.dueDate} and is now ${days(f.daysOverdue)} overdue. Our agreed payment terms are ${f.paymentTerms}.`,
      "If paying it all at once is difficult, reply to this email and we can split the remaining amount into installments.",
      payBlock(f),
    ],
    f.freelancerName,
  ),
});

const tier3 = (f: ReminderFacts): Draft => ({
  subject: subject(`Final notice: invoice ${f.invoiceNumber}`),
  body: letter(
    f.clientName,
    [
      `This is a final notice for invoice ${f.invoiceNumber} (${which(f)}), which was due on ${f.dueDate} and is now ${days(f.daysOverdue)} overdue. I've sent earlier reminders about it. Our agreed payment terms are ${f.paymentTerms}.`,
      ...(f.citation ? [f.citation.text] : []),
      "Please pay the invoice now, or reply to this email so we can agree a plan.",
      payBlock(f),
    ],
    f.freelancerName,
  ),
});

const maintenance = (f: MaintenanceFacts): Draft => ({
  subject: subject(
    `${f.type === "renewal" ? "Renewal" : "Maintenance"} coming up: ${f.projectTitle}`,
  ),
  body: letter(
    f.clientName,
    [
      `A heads-up that ${f.task} for ${f.projectTitle} is coming up on ${f.dueDate}.${
        f.estimatedCost ? ` The estimated cost is ${f.estimatedCost}.` : ""
      }`,
      "Reply to confirm, or if you have any questions.",
    ],
    f.freelancerName,
  ),
});

const autoPayApproval = (f: AutoPayFacts): Draft => ({
  subject: subject(`Please approve auto-pay: ${f.retainerName}`),
  body: letter(
    f.clientName,
    [
      `I've set up ${f.retainerName} as auto-pay through PayPal: ${f.amount} ${f.repeat}, with the first charge on ${f.firstCharge}, ${
        f.lastCharge ? `and the last on ${f.lastCharge}` : "until cancelled"
      }.`,
      `PayPal charges nothing until you approve it. You can do that here:\n${f.approvalLink}`,
      "Reply if you have any questions.",
    ],
    f.freelancerName,
  ),
});

export const draftTemplate = (request: DraftRequest): Draft => {
  switch (request.kind) {
    case "courtesy":
      return courtesy(request.facts);
    case "tier1":
      return tier1(request.facts);
    case "tier2":
      return tier2(request.facts);
    case "tier3":
      return tier3(request.facts);
    case "maintenance":
      return maintenance(request.facts);
    case "auto_pay_approval":
      return autoPayApproval(request.facts);
  }
};
