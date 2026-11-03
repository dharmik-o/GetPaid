-- 001_init: the 11 MVP tables (docs/MVP-spec.md, Data model).
--
-- Conventions
--   * uuid ids; created_at / updated_at are timestamptz (UTC).
--   * Money is bigint cents plus an ISO 4217 currency column. No floats or numeric.
--   * Every table carries user_id. Child tables reference their parent through (id, user_id),
--     so a row can never point at another user's data.
--   * Row-level security on every table, limited to the owner: user_id = auth.uid().
--     On Supabase, auth.uid() is built in; locally it comes from db/dev/000_supabase_auth_stub.sql.
--   * Roles: authenticated = dashboard users (RLS applies). service_role bypasses RLS and is for
--     n8n and webhook handlers only. anon gets nothing.
--   * *_enc columns hold ciphertext from apps/web/src/lib/crypto.ts only.

CREATE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- users: one row per freelancer, keyed by the auth user id ---------------------------------
CREATE TABLE public.users (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  gmail_token_enc text,
  paypal_account text,
  telegram_chat_id bigint UNIQUE,
  default_settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(default_settings) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.users.gmail_token_enc IS 'Ciphertext from lib/crypto.ts only.';
COMMENT ON COLUMN public.users.default_settings IS 'Account-level schedule settings; merged with client, project and milestone overrides at runtime.';

-- ai_providers: bring-your-own-AI settings per task ---------------------------------------
CREATE TABLE public.ai_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  task text NOT NULL CHECK (task IN ('sort', 'draft', 'tier3')),
  provider text NOT NULL,
  base_url text NOT NULL,
  model text NOT NULL,
  api_key_enc text,
  fallback_order smallint NOT NULL DEFAULT 1 CHECK (fallback_order >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, task, fallback_order)
);
COMMENT ON COLUMN public.ai_providers.api_key_enc IS 'Ciphertext from lib/crypto.ts only. NULL for local models.';

-- clients ----------------------------------------------------------------------------------
CREATE TABLE public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  time_zone text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
COMMENT ON COLUMN public.clients.time_zone IS 'IANA zone (e.g. America/New_York); send windows are worked out in this zone.';

-- projects ---------------------------------------------------------------------------------
CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  client_id uuid NOT NULL,
  title text NOT NULL,
  total_cents bigint NOT NULL CHECK (total_cents > 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  contract_terms text,
  late_fee_clause text,
  settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (id, user_id, currency),
  FOREIGN KEY (client_id, user_id) REFERENCES public.clients (id, user_id) ON DELETE CASCADE
);
COMMENT ON COLUMN public.projects.late_fee_clause IS 'The contract''s own late-fee clause; the only fee Tier 3 may cite besides legal/statutes.json.';

-- milestones -------------------------------------------------------------------------------
CREATE TABLE public.milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL,
  currency text NOT NULL,
  position smallint NOT NULL CHECK (position >= 1),
  name text NOT NULL,
  deliverable text,
  amount_cents bigint CHECK (amount_cents > 0),
  percent_bp integer CHECK (percent_bp BETWEEN 1 AND 10000),
  deadline date NOT NULL,
  acceptance_window_days smallint CHECK (acceptance_window_days >= 0),
  payment_mode text NOT NULL DEFAULT 'pay_on_invoice'
    CHECK (payment_mode IN ('pay_on_invoice', 'deposit', 'hold')),
  settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned', 'in_progress', 'delivered', 'accepted', 'invoiced',
    'paid', 'partially_paid', 'overdue', 'disputed'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT milestones_amount_or_percent CHECK (num_nonnulls(amount_cents, percent_bp) = 1),
  UNIQUE (id, user_id),
  UNIQUE (project_id, position) DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (project_id, user_id, currency)
    REFERENCES public.projects (id, user_id, currency) ON DELETE CASCADE ON UPDATE CASCADE
);
COMMENT ON COLUMN public.milestones.currency IS 'Always the project''s currency (enforced by the foreign key, follows project changes).';
COMMENT ON COLUMN public.milestones.percent_bp IS 'Share of the project total in basis points (30% = 3000). Converting to cents: round each, and the last milestone by position absorbs the remainder so totals equal the project total.';

-- retainers --------------------------------------------------------------------------------
CREATE TABLE public.retainers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  client_id uuid NOT NULL,
  project_id uuid,
  name text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  interval_unit text NOT NULL CHECK (interval_unit IN ('week', 'month')),
  interval_count smallint NOT NULL DEFAULT 1 CHECK (interval_count >= 1),
  starts_on date NOT NULL,
  ends_on date CHECK (ends_on IS NULL OR ends_on >= starts_on),
  method text NOT NULL CHECK (method IN ('auto_pay', 'invoice')),
  paypal_subscription_id text UNIQUE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending_approval', 'active', 'suspended', 'cancelled', 'ended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (client_id, user_id) REFERENCES public.clients (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, user_id) REFERENCES public.projects (id, user_id) ON DELETE SET NULL (project_id)
);
COMMENT ON COLUMN public.retainers.ends_on IS 'NULL means until cancelled.';

-- maintenance_tasks: maintenance jobs and renewals (reminders go to the freelancer) ---------
CREATE TABLE public.maintenance_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('maintenance', 'renewal')),
  task text NOT NULL,
  repeat_months smallint NOT NULL CHECK (repeat_months >= 1),
  next_due date NOT NULL,
  est_cost_cents bigint CHECK (est_cost_cents >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  lead_days smallint[] NOT NULL DEFAULT '{14,1}' CHECK (0 <= ALL (lead_days)),
  repeat_from text NOT NULL DEFAULT 'scheduled' CHECK (repeat_from IN ('done', 'scheduled')),
  checklist jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(checklist) = 'array'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, user_id) REFERENCES public.projects (id, user_id) ON DELETE CASCADE
);

-- invoices: one PayPal invoice per milestone or retainer cycle, reused in every reminder ----
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  milestone_id uuid,
  retainer_id uuid,
  paypal_invoice_id text UNIQUE,
  paypal_order_id text UNIQUE,
  paypal_request_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  link text,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  amount_paid_cents bigint NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  due_date date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'sent', 'partially_paid', 'paid', 'cancelled', 'refunded', 'disputed'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_one_source CHECK (num_nonnulls(milestone_id, retainer_id) = 1),
  UNIQUE (id, user_id),
  FOREIGN KEY (milestone_id, user_id) REFERENCES public.milestones (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (retainer_id, user_id) REFERENCES public.retainers (id, user_id) ON DELETE CASCADE
);
COMMENT ON COLUMN public.invoices.paypal_request_id IS 'Sent as the PayPal-Request-Id header on the create call; reused on retries so PayPal never creates a duplicate.';

-- A milestone has at most one invoice that isn't cancelled.
CREATE UNIQUE INDEX invoices_one_open_per_milestone
  ON public.invoices (milestone_id) WHERE status <> 'cancelled';

-- reminders: drafts and their approval -----------------------------------------------------
CREATE TABLE public.reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  tier text NOT NULL CHECK (tier IN ('courtesy', 'tier1', 'tier2', 'tier3')),
  scheduled_at timestamptz NOT NULL,
  draft jsonb CHECK (draft IS NULL OR jsonb_typeof(draft) = 'object'),
  approval_status text NOT NULL DEFAULT 'waiting'
    CHECK (approval_status IN ('waiting', 'approved', 'skipped')),
  approved_via text CHECK (approved_via IN ('outbox', 'telegram')),
  telegram_message_id bigint,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminders_via_only_when_approved
    CHECK (approved_via IS NULL OR approval_status = 'approved'),
  -- Nothing sends without approval: a send can only be recorded for an approved draft.
  CONSTRAINT reminders_sent_only_when_approved
    CHECK (sent_at IS NULL OR (approval_status = 'approved' AND draft IS NOT NULL)),
  FOREIGN KEY (invoice_id, user_id) REFERENCES public.invoices (id, user_id) ON DELETE CASCADE
);
COMMENT ON COLUMN public.reminders.scheduled_at IS 'An instant, stored in UTC. The send window is worked out in the client''s time zone (clients.time_zone) by lib/schedule.ts.';

-- messages: emails in and out on the invoice thread ----------------------------------------
CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  body text NOT NULL,
  ai_classification jsonb CHECK (ai_classification IS NULL OR jsonb_typeof(ai_classification) = 'object'),
  thread_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invoice_id, user_id) REFERENCES public.invoices (id, user_id) ON DELETE CASCADE
);
COMMENT ON COLUMN public.messages.ai_classification IS 'Suggestion only. Never changes an invoice status, amount, schedule or approval by itself.';

-- events: append-only audit log behind the evidence timeline --------------------------------
CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  entity text NOT NULL,
  entity_id uuid,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- updated_at triggers ----------------------------------------------------------------------
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER ai_providers_set_updated_at BEFORE UPDATE ON public.ai_providers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER clients_set_updated_at BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER milestones_set_updated_at BEFORE UPDATE ON public.milestones
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER retainers_set_updated_at BEFORE UPDATE ON public.retainers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER maintenance_tasks_set_updated_at BEFORE UPDATE ON public.maintenance_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER invoices_set_updated_at BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER reminders_set_updated_at BEFORE UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER messages_set_updated_at BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Row-level security: every table, owner only ------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retainers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_owner ON public.users FOR ALL TO authenticated
  USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY ai_providers_owner ON public.ai_providers FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY clients_owner ON public.clients FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY projects_owner ON public.projects FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY milestones_owner ON public.milestones FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY retainers_owner ON public.retainers FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY maintenance_tasks_owner ON public.maintenance_tasks FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY invoices_owner ON public.invoices FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY reminders_owner ON public.reminders FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY messages_owner ON public.messages FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
-- events: read and append only; no update or delete policy exists.
CREATE POLICY events_owner_read ON public.events FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY events_owner_append ON public.events FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Privileges -------------------------------------------------------------------------------
-- Supabase grants anon access to new public tables by default; take it back explicitly.
REVOKE ALL ON
  public.users, public.ai_providers, public.clients, public.projects, public.milestones,
  public.retainers, public.maintenance_tasks, public.invoices, public.reminders,
  public.messages, public.events
FROM anon;

GRANT USAGE ON SCHEMA public TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.users, public.ai_providers, public.clients, public.projects, public.milestones,
  public.retainers, public.maintenance_tasks, public.invoices, public.reminders, public.messages
TO authenticated, service_role;

-- Append-only for everyone, including the service role.
REVOKE UPDATE, DELETE, TRUNCATE ON public.events FROM authenticated, service_role;
GRANT SELECT, INSERT ON public.events TO authenticated, service_role;
