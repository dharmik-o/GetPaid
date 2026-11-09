-- 029_legal_facts: Phase 2 part C, step C1. The facts the late-payment laws need. The plan called
-- this 028, but A5 took that number, so part C starts at 029 (the agreements are 030).
--   * clients.region: the client's state or province, for laws that differ by state (US, CA, AU, IN)
--   * clients.is_business: UK and EU late-payment laws cover business-to-business debts only
--   * users: the freelancer's legal name, Udyam (MSME) number and the country whose law governs
--     their contracts

ALTER TABLE public.clients
  ADD COLUMN region text CHECK (region ~ '^[A-Z0-9]{1,3}$'),
  ADD COLUMN is_business boolean NOT NULL DEFAULT true;
ALTER TABLE public.users
  ADD COLUMN udyam_number text CHECK (udyam_number ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$'),
  ADD COLUMN legal_name text CHECK (char_length(legal_name) <= 160),
  ADD COLUMN governing_law_country text CHECK (governing_law_country ~ '^[A-Z]{2}$');

COMMENT ON COLUMN public.clients.region IS 'ISO 3166-2 subdivision code without the country, e.g. NY. Only asked for US, CA, AU and IN clients.';
COMMENT ON COLUMN public.clients.is_business IS 'False for a private person. B2B-only laws are never cited for them.';
COMMENT ON COLUMN public.users.udyam_number IS 'MSME registration; the MSMED Act applies only with it.';
