-- 026_invoice_archive: every invoice PDF sent to a client is kept in a folder the freelancer can
-- browse (INVOICE_ARCHIVE_DIR). This table says which file is which (M11).
--
-- Rows are nearly append-only: the only change allowed is recording when a file was first sent. The
-- app never overwrites or deletes a file, and has no way to delete a row, so the record of what a
-- client was sent can't be edited. A row goes only with its invoice; its file stays on disk.

CREATE TABLE public.invoice_archive_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  relative_path text NOT NULL CHECK (char_length(relative_path) BETWEEN 1 AND 400),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 text CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  template_name text,
  signed boolean NOT NULL DEFAULT false,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT public.demo_clock_now(),
  UNIQUE (invoice_id, version),
  UNIQUE (user_id, relative_path)
);
COMMENT ON TABLE public.invoice_archive_files IS 'One row per saved PDF of an invoice. The path is relative to INVOICE_ARCHIVE_DIR.';
COMMENT ON COLUMN public.invoice_archive_files.sha256 IS 'Of the PDF file itself.';
COMMENT ON COLUMN public.invoice_archive_files.source_sha256 IS 'Of the document the PDF was made from. Chromium stamps each PDF with the time, so two PDFs of one document differ in bytes: this is what says whether a document changed. NULL for a PDF moved in from before the archive.';
COMMENT ON COLUMN public.invoice_archive_files.sent_at IS 'When a client was first sent this version. NULL if it never went.';
CREATE INDEX invoice_archive_files_user_id_idx ON public.invoice_archive_files (user_id);

ALTER TABLE public.invoice_archive_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_archive_files_read ON public.invoice_archive_files FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY invoice_archive_files_insert ON public.invoice_archive_files FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY invoice_archive_files_mark_sent ON public.invoice_archive_files FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
REVOKE ALL ON public.invoice_archive_files FROM anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.invoice_archive_files TO authenticated, service_role;
GRANT UPDATE (sent_at) ON public.invoice_archive_files TO authenticated, service_role;

-- The working copy of a PDF before it's sent, and which document it was made from. ------------
ALTER TABLE public.invoices
  ADD COLUMN pdf_source_sha256 text CHECK (pdf_source_sha256 ~ '^[0-9a-f]{64}$');
COMMENT ON COLUMN public.invoices.pdf_source_sha256 IS 'Which document the PDF at pdf_path was made from, so a changed one is made again.';

-- A reminder waits if its PDF can't be saved: nothing goes out without a copy kept. ------------
ALTER TABLE public.reminders DROP CONSTRAINT reminders_send_blocked_reason_check;
ALTER TABLE public.reminders ADD CONSTRAINT reminders_send_blocked_reason_check
  CHECK (send_blocked_reason IN ('gmail_disconnected', 'not_allowlisted', 'draft_invalid',
    'no_pay_link', 'paused', 'on_hold', 'send_failed', 'pdf_failed', 'archive_failed',
    'unknown_outcome'));
