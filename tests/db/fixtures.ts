/** The 11 MVP tables (docs/MVP-spec.md, Data model), in foreign-key order. */
export const OWNED_TABLES = [
  "users",
  "ai_providers",
  "clients",
  "projects",
  "milestones",
  "retainers",
  "maintenance_tasks",
  "invoices",
  "reminders",
  "messages",
  "events",
] as const;

export type OwnedTable = (typeof OWNED_TABLES)[number];

/** `users` is owned through its primary key; every other table through `user_id`. */
export const ownerColumn = (table: OwnedTable): "id" | "user_id" =>
  table === "users" ? "id" : "user_id";

export interface Owner {
  label: "a" | "b";
  userId: string;
  rows: Record<OwnedTable, string>;
}

const uuidFor = (label: Owner["label"], index: number): string =>
  `${label.repeat(8)}-0000-4000-8000-${String(index).padStart(12, "0")}`;

const makeOwner = (label: Owner["label"]): Owner => {
  const rows = Object.fromEntries(
    OWNED_TABLES.map((table, index) => [table, uuidFor(label, index)]),
  ) as Record<OwnedTable, string>;
  return { label, userId: rows.users, rows };
};

export const USER_A = makeOwner("a");
export const USER_B = makeOwner("b");

/** One row in every table for this owner. Fake data only; run as the table owner. */
export const seedOwnerSql = ({ label, userId: u, rows: r }: Owner): string => `
  INSERT INTO auth.users (id, email) VALUES ('${u}', 'freelancer-${label}@example.test');
  INSERT INTO public.users (id, name, email) VALUES ('${u}', 'Freelancer ${label}', 'freelancer-${label}@example.test');
  INSERT INTO public.ai_providers (id, user_id, task, provider, base_url, model)
    VALUES ('${r.ai_providers}', '${u}', 'draft', 'mock', 'http://localhost:4000', 'mock');
  INSERT INTO public.clients (id, user_id, name, email, country, time_zone)
    VALUES ('${r.clients}', '${u}', 'Client ${label}', 'client-${label}@example.test', 'US', 'America/New_York');
  INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency)
    VALUES ('${r.projects}', '${u}', '${r.clients}', 'Website redesign', 300000, 'USD');
  INSERT INTO public.milestones (id, user_id, project_id, currency, position, name, percent_bp, deadline, payment_mode)
    VALUES ('${r.milestones}', '${u}', '${r.projects}', 'USD', 1, 'Design', 3000, '2026-12-01', 'deposit');
  INSERT INTO public.retainers (id, user_id, client_id, project_id, name, amount_cents, currency, interval_unit, starts_on, method)
    VALUES ('${r.retainers}', '${u}', '${r.clients}', '${r.projects}', 'Monthly maintenance', 20000, 'USD', 'month', '2026-12-01', 'invoice');
  INSERT INTO public.maintenance_tasks (id, user_id, project_id, type, task, repeat_months, next_due, est_cost_cents, currency)
    VALUES ('${r.maintenance_tasks}', '${u}', '${r.projects}', 'maintenance', 'Security updates and backups', 6, '2027-05-15', 20000, 'USD');
  INSERT INTO public.invoices (id, user_id, milestone_id, amount_cents, currency, due_date)
    VALUES ('${r.invoices}', '${u}', '${r.milestones}', 90000, 'USD', '2026-12-08');
  INSERT INTO public.reminders (id, user_id, invoice_id, tier, scheduled_at)
    VALUES ('${r.reminders}', '${u}', '${r.invoices}', 'tier1', '2026-12-09T14:00:00Z');
  INSERT INTO public.messages (id, user_id, invoice_id, direction, body, thread_id)
    VALUES ('${r.messages}', '${u}', '${r.invoices}', 'out', 'Friendly reminder', 'thread-${label}');
  INSERT INTO public.events (id, user_id, entity, entity_id, type)
    VALUES ('${r.events}', '${u}', 'invoice', '${r.invoices}', 'invoice.created');
`;
