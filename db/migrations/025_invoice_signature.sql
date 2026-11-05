-- 025_invoice_signature: an optional picture of the freelancer's signature on invoices (M11).
--
-- It's an embedded image, like the logo, so a PDF never loads anything. A typed name is drawn to a
-- PNG in a handwriting font when it's saved, so a template has one kind of signature to show. This
-- is not a legal e-signature. The choice is stored per invoice, and a retainer keeps it for the
-- invoices its cycles create.

ALTER TABLE public.users
  ADD COLUMN signature_source text CHECK (signature_source IN ('upload', 'typed')),
  ADD COLUMN signature_image_data_url text CHECK (
    signature_image_data_url ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$'
    AND char_length(signature_image_data_url) <= 700000
  ),
  ADD COLUMN signature_typed_name text CHECK (char_length(signature_typed_name) <= 120),
  ADD COLUMN signature_name text CHECK (char_length(signature_name) <= 120),
  ADD COLUMN signature_title text CHECK (char_length(signature_title) <= 120),
  ADD COLUMN signature_default boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT users_signature_has_image CHECK (
    (signature_source IS NULL) = (signature_image_data_url IS NULL)
  );
COMMENT ON COLUMN public.users.signature_image_data_url IS 'A PNG or JPEG data URL of at most 500 KB, uploaded or drawn from a typed name. No SVG. Never logged.';
COMMENT ON COLUMN public.users.signature_default IS 'Whether "Include my signature" starts ticked on a new invoice.';

ALTER TABLE public.invoices
  ADD COLUMN include_signature boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.invoices.include_signature IS 'The freelancer''s choice for this invoice. No signature set up means none is shown, whatever this says.';

ALTER TABLE public.retainers
  ADD COLUMN include_signature boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.retainers.include_signature IS 'Copied onto each cycle''s invoice.';
