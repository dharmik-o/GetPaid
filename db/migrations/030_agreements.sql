-- 030_agreements: Phase 2 part C, step C2. Project agreements, and the reminder changes the agreement
-- emails (C3) will need. The plan called this part of 029_contracts.sql; C1 shipped as 029 (the
-- columns), so the agreements are 030.

CREATE TABLE public.agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  client_id uuid NOT NULL,
  number text NOT NULL CHECK (number ~ '^AGR-[0-9]{6}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'object'),   -- clause options
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object'),       -- snapshot of the data filled in
  body_html text NOT NULL,                                            -- the exact document the client sees
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'signed', 'declined', 'expired', 'void')),
  freelancer_signed_name text,
  freelancer_signed_at timestamptz,
  token_sha256 text CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  token_expires_at timestamptz,
  sent_at timestamptz,
  first_viewed_at timestamptz,
  signer_name text CHECK (char_length(signer_name) <= 160),
  signer_email text CHECK (char_length(signer_email) <= 254),
  signer_ip text CHECK (char_length(signer_ip) <= 64),
  signer_user_agent text CHECK (char_length(signer_user_agent) <= 400),
  signed_at timestamptz,
  decline_reason text CHECK (char_length(decline_reason) <= 1000),
  signed_pdf_path text,                     -- relative to INVOICE_ARCHIVE_DIR
  signed_pdf_sha256 text CHECK (signed_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT public.demo_clock_now(),
  updated_at timestamptz NOT NULL DEFAULT public.demo_clock_now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, number, version),
  CONSTRAINT agreements_project_fkey FOREIGN KEY (project_id, user_id)
    REFERENCES public.projects (id, user_id) ON DELETE CASCADE,
  CONSTRAINT agreements_client_fkey FOREIGN KEY (client_id, user_id)
    REFERENCES public.clients (id, user_id) ON DELETE CASCADE,
  CONSTRAINT agreements_signed_fields CHECK (status <> 'signed' OR
    (signer_name IS NOT NULL AND signed_at IS NOT NULL AND signer_ip IS NOT NULL))
);
COMMENT ON TABLE public.agreements IS 'A project agreement the client signs online. Once sent, the document never changes: a change is a new version.';
COMMENT ON COLUMN public.agreements.token_sha256 IS 'SHA-256 of the signing link''s token. The token itself is never stored.';
CREATE INDEX agreements_user_id_idx ON public.agreements (user_id);
CREATE INDEX agreements_project_id_idx ON public.agreements (project_id);
CREATE INDEX agreements_client_id_idx ON public.agreements (client_id);
-- One agreement in progress per project.
CREATE UNIQUE INDEX agreements_one_live_per_project ON public.agreements (project_id)
  WHERE status IN ('draft', 'sent');

-- Once sent, the document can't change. A change after sending = a new version (a new row), and
-- the old one is set to 'void'.
CREATE FUNCTION public.agreements_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
     NEW.body_html IS DISTINCT FROM OLD.body_html OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256 OR
     NEW.options IS DISTINCT FROM OLD.options OR NEW.facts IS DISTINCT FROM OLD.facts OR
     NEW.number IS DISTINCT FROM OLD.number OR NEW.version IS DISTINCT FROM OLD.version OR
     NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.client_id IS DISTINCT FROM OLD.client_id) THEN
    RAISE EXCEPTION 'agreement % is %, its document can no longer change', OLD.number, OLD.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agreements_freeze BEFORE UPDATE ON public.agreements
  FOR EACH ROW EXECUTE FUNCTION public.agreements_freeze();
CREATE TRIGGER agreements_set_updated_at BEFORE UPDATE ON public.agreements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.agreements ENABLE ROW LEVEL SECURITY;
CREATE POLICY agreements_read ON public.agreements FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY agreements_insert ON public.agreements FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY agreements_update ON public.agreements FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
-- No DELETE grant: drafts are voided, not deleted. A row goes only with its project.
REVOKE ALL ON public.agreements FROM anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.agreements TO authenticated, service_role;

-- The agreement emails are reminders with an agreement as their source (follows 021's pattern).
-- 'final_demand' uses invoice_id as its source, like tier3.
ALTER TABLE public.reminders
  ADD COLUMN agreement_id uuid,
  DROP CONSTRAINT reminders_tier_check,
  ADD CONSTRAINT reminders_tier_check CHECK (tier IN (
    'courtesy', 'tier1', 'tier2', 'tier3', 'maintenance', 'auto_pay_approval', 'hold_approval',
    'agreement_request', 'agreement_signed_copy', 'final_demand')),
  DROP CONSTRAINT reminders_one_source,
  ADD CONSTRAINT reminders_one_source
    CHECK (num_nonnulls(invoice_id, maintenance_task_id, retainer_id, hold_id, agreement_id) = 1),
  ADD CONSTRAINT reminders_agreement_tier
    CHECK ((tier IN ('agreement_request', 'agreement_signed_copy')) = (agreement_id IS NOT NULL)),
  ADD CONSTRAINT reminders_agreement_fkey
    FOREIGN KEY (agreement_id, user_id) REFERENCES public.agreements (id, user_id) ON DELETE CASCADE;
CREATE INDEX reminders_agreement_id_idx ON public.reminders (agreement_id);
