// The words and targets of the guided tour (T1). Pure data, shared by the server (which keys are
// valid) and the browser (what to show). Every target is a `data-tour="..."` attribute on a real
// element; a step whose target isn't on the page shows centred instead.

export const TIP_KEYS = ["project", "calendar", "agreement", "client"] as const;
export type TipKey = (typeof TIP_KEYS)[number];

export type TourStep = { target?: string; title: string; body: string };
export type MainStep = TourStep & { path: string };

/** The main tour. Step 4 opens the user's first project, or the project list when there is none. */
export const mainSteps = (projectId: string | null): MainStep[] => [
  {
    path: "/",
    target: "needs-attention",
    title: "Start here",
    body: "Needs attention lists the drafts waiting for you and the invoices that are overdue.",
  },
  {
    path: "/",
    target: "nav-clients",
    title: "Clients",
    body: "Add each client here. Their country sets the time zone their reminders use.",
  },
  {
    path: "/projects",
    target: "new-project",
    title: "New project",
    body: "Set the deadline, payment terms and reminder schedule once for each project.",
  },
  {
    path: projectId ? `/projects/${projectId}` : "/projects",
    target: "milestone-card",
    title: "Milestones",
    body: "Each milestone becomes a PayPal invoice. PAID and OVERDUE stamps show where it stands.",
  },
  {
    path: projectId ? `/projects/${projectId}` : "/projects",
    target: "record-payment",
    title: "Paid another way?",
    body: "If a client pays by bank transfer, UPI, cash, cheque or another app, press Record a payment on the invoice. GetPaid closes the PayPal invoice, marks it paid and stops its reminders.",
  },
  {
    path: "/outbox",
    target: "outbox-card",
    title: "Outbox",
    body: "AI drafts each reminder here. Approve, edit, skip or reschedule it; nothing sends before you approve.",
  },
  {
    path: "/calendar",
    target: "calendar-month",
    title: "Calendar",
    body: "Deadlines, due dates and your own entries in one place. Click a day to see it.",
  },
  {
    path: "/settings/integrations",
    target: "integrations",
    title: "Integrations",
    body: "Connect Telegram to approve on your phone, Gmail to send from your address, and PayPal for pay links.",
  },
  {
    path: "/settings/ai",
    target: "ai-model",
    title: "AI model",
    body: "Choose the model that writes your drafts, a local one or a cloud provider.",
  },
  {
    path: "/settings",
    title: "You're set",
    body: "Replay this tour any time from Settings.",
  },
];

/** Page tips: shown once, the first time a page is opened after the main tour. */
export const TIPS: Record<TipKey, TourStep[]> = {
  project: [
    {
      target: "project-summary",
      title: "Project summary",
      body: "The total, deadline, status and reminder schedule for this project.",
    },
    {
      target: "milestone-card",
      title: "Milestone cards",
      body: "Each card shows its invoice, what is paid and the next reminder.",
    },
    {
      target: "record-payment",
      title: "Paid outside PayPal",
      body: "Record a payment closes an invoice paid by bank transfer, UPI, cash or cheque. You confirm it first.",
    },
    {
      target: "project-agreement",
      title: "Agreement",
      body: "Draft an agreement for this project, then send it for signature.",
    },
    {
      target: "project-lawyer-pack",
      title: "Lawyer pack",
      body: "Download the agreement, invoices, timeline and demands as one PDF.",
    },
  ],
  calendar: [
    {
      target: "calendar-month",
      title: "Click a day",
      body: "See what is due that day, and add, edit or delete your own entries.",
    },
    {
      target: "calendar-sources",
      title: "Imported calendars",
      body: "Add a calendar's address or file to show its events here.",
    },
    {
      target: "calendar-assistant",
      title: "Ask the assistant",
      body: "Ask about your dates. Any change it suggests applies only after you click.",
    },
  ],
  agreement: [
    {
      target: "agreement-options",
      title: "Options",
      body: "Set the deposit, payment days, revisions and late-payment terms.",
    },
    {
      target: "agreement-preview",
      title: "Preview",
      body: "This is the document the client will read and sign.",
    },
    {
      target: "agreement-send",
      title: "Send for signature",
      body: "Sending puts an email in your Outbox. Nothing reaches the client until you approve it.",
    },
  ],
  client: [
    {
      target: "client-timeline",
      title: "Timeline",
      body: "Open a row to read the email you sent.",
    },
    {
      target: "client-ai-suggestion",
      title: "AI suggestion",
      body: "The AI only suggests how to read a reply. It never changes an invoice or sends anything.",
    },
  ],
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TIP_PAGES: [RegExp, TipKey][] = [
  [new RegExp(`^/projects/${UUID}$`, "i"), "project"],
  [new RegExp(`^/projects/${UUID}/agreement$`, "i"), "agreement"],
  [/^\/calendar$/, "calendar"],
  [new RegExp(`^/clients/${UUID}$`, "i"), "client"],
];

/** Which page tip belongs to this address, if any. */
export const tipForPath = (pathname: string): TipKey | null =>
  TIP_PAGES.find(([pattern]) => pattern.test(pathname))?.[1] ?? null;
