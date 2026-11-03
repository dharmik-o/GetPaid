-- 009_invoice_templates: the freelancer's own invoice document (approved change, 3 Nov 2026).
--
-- A template is HTML and CSS with logic-less {{tags}} the app fills in, rendered to a PDF by
-- headless Chromium with JavaScript and network off. Custom templates are untrusted input: the
-- app sanitises them before saving (lib/template-sanitize.ts); the size check here backs that up.
-- Built-ins have no owner (user_id NULL): every signed-in user can read and copy them, nobody
-- can change them. The default is per account (users) and per client (clients).

CREATE TABLE public.invoice_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('builtin', 'custom')),
  html text NOT NULL,
  css text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_templates_builtin_unowned CHECK ((kind = 'builtin') = (user_id IS NULL)),
  CONSTRAINT invoice_templates_size CHECK (octet_length(html) + octet_length(css) <= 102400)
);
COMMENT ON TABLE public.invoice_templates IS 'Invoice document templates. Built-ins (user_id NULL) are read-only; custom ones are sanitised by the app before saving.';
CREATE INDEX invoice_templates_user_id_idx ON public.invoice_templates (user_id);

CREATE TRIGGER invoice_templates_set_updated_at BEFORE UPDATE ON public.invoice_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.invoice_templates ENABLE ROW LEVEL SECURITY;
-- Built-ins only for a signed-in user; custom templates only for their owner.
CREATE POLICY invoice_templates_read ON public.invoice_templates FOR SELECT TO authenticated
  USING ((user_id IS NULL AND (SELECT auth.uid()) IS NOT NULL) OR user_id = (SELECT auth.uid()));
CREATE POLICY invoice_templates_insert ON public.invoice_templates FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND kind = 'custom');
CREATE POLICY invoice_templates_update ON public.invoice_templates FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()) AND kind = 'custom');
CREATE POLICY invoice_templates_delete ON public.invoice_templates FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));
REVOKE ALL ON public.invoice_templates FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_templates TO authenticated, service_role;

-- Defaults, the freelancer's and client's details for the document, and each invoice's own. --
ALTER TABLE public.users
  ADD COLUMN default_template_id uuid REFERENCES public.invoice_templates (id) ON DELETE SET NULL,
  ADD COLUMN business_name text CHECK (char_length(business_name) <= 120),
  ADD COLUMN address text CHECK (char_length(address) <= 500),
  ADD COLUMN logo_data_url text CHECK (
    logo_data_url ~ '^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$'
    AND char_length(logo_data_url) <= 300000
  );
COMMENT ON COLUMN public.users.default_template_id IS 'The account''s default invoice template; NULL = Classic.';
COMMENT ON COLUMN public.users.logo_data_url IS 'The logo as an embedded data URL, so a PDF never loads anything from the network.';
CREATE INDEX users_default_template_id_idx ON public.users (default_template_id);

ALTER TABLE public.clients
  ADD COLUMN default_template_id uuid REFERENCES public.invoice_templates (id) ON DELETE SET NULL,
  ADD COLUMN company text CHECK (char_length(company) <= 120),
  ADD COLUMN address text CHECK (char_length(address) <= 500);
COMMENT ON COLUMN public.clients.default_template_id IS 'Overrides the account default for this client; NULL = the account default.';
CREATE INDEX clients_default_template_id_idx ON public.clients (default_template_id);

ALTER TABLE public.invoices
  ADD COLUMN template_id uuid REFERENCES public.invoice_templates (id) ON DELETE SET NULL,
  ADD COLUMN pdf_path text,
  ADD COLUMN invoice_text jsonb CHECK (invoice_text IS NULL OR jsonb_typeof(invoice_text) = 'object');
COMMENT ON COLUMN public.invoices.pdf_path IS 'Where the rendered PDF is stored, relative to INVOICE_PDF_DIR.';
COMMENT ON COLUMN public.invoices.invoice_text IS 'The text tags (greeting, thank-you note, project summary, notes) as approved by the freelancer. Never amounts or dates.';
CREATE INDEX invoices_template_id_idx ON public.invoices (template_id);

-- The three built-ins ------------------------------------------------------------------------
INSERT INTO public.invoice_templates (id, user_id, name, kind, html, css) VALUES
('00000000-0000-4000-8000-00000000c001', NULL, 'Classic', 'builtin', $html$<div class="invoice">
  <header class="head">
    <div class="from">
      {{#freelancer.logo}}<img class="logo" src="{{freelancer.logo}}" alt="Logo">{{/freelancer.logo}}
      <div class="from-name">{{freelancer.business_name}}{{^freelancer.business_name}}{{freelancer.name}}{{/freelancer.business_name}}</div>
      <div class="muted">{{freelancer.address}}</div>
      <div class="muted">{{freelancer.email}}</div>
    </div>
    <div class="meta">
      <h1>Invoice</h1>
      <table class="meta-table">
        <tr><th>Number</th><td>{{invoice.number}}</td></tr>
        <tr><th>Issued</th><td>{{invoice.issue_date}}</td></tr>
        <tr><th>Due</th><td>{{invoice.due_date}}</td></tr>
        <tr><th>Terms</th><td>{{invoice.terms}}</td></tr>
      </table>
    </div>
  </header>
  <section class="bill-to">
    <div class="label">Bill to</div>
    <div>{{client.name}}</div>
    <div>{{client.company}}</div>
    <div class="muted">{{client.address}}</div>
    <div class="muted">{{client.email}}</div>
  </section>
  <p>{{greeting}}</p>
  <p>{{project_summary}}</p>
  <h2>{{invoice.title}}</h2>
  <table class="items">
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
    <tbody>{{#items}}<tr><td><strong>{{name}}</strong><div class="muted">{{description}}</div></td><td class="num">{{quantity}}</td><td class="num">{{unit_price}}</td><td class="num">{{amount}}</td></tr>{{/items}}</tbody>
  </table>
  <table class="totals">
    <tr><th>Subtotal</th><td class="num">{{totals.subtotal}}</td></tr>
    <tr><th>Tax</th><td class="num">{{totals.tax}}</td></tr>
    <tr><th>Discount</th><td class="num">{{totals.discount}}</td></tr>
    <tr class="grand"><th>Total ({{currency}})</th><td class="num">{{totals.total}}</td></tr>
  </table>
  {{#installment.number}}<section class="installments">
    <h3>Installment {{installment.number}} of {{installment.count}}</h3>
    <p>Paid so far: {{installment.paid_so_far}}. Remaining after this one: {{installment.remaining}}.</p>
    <table class="schedule">{{#installment.schedule}}<tr><td>Installment {{number}}</td><td class="num">{{amount}}</td><td>{{due_date}}</td><td>{{status}}</td></tr>{{/installment.schedule}}</table>
  </section>{{/installment.number}}
  <section class="pay">
    <div class="label">Pay online</div>
    <a href="{{invoice.pay_link}}">{{invoice.pay_link}}</a>
  </section>
  {{#invoice.late_fee_clause}}<p class="small">Late payment: {{invoice.late_fee_clause}}</p>{{/invoice.late_fee_clause}}
  <p>{{notes}}</p>
  <p>{{thank_you_note}}</p>
</div>$html$, $css$@page { size: A4; margin: 18mm; }
body { font-family: Georgia, "Times New Roman", serif; color: #1f2933; font-size: 12px; line-height: 1.5; margin: 0; }
.head { display: flex; justify-content: space-between; border-bottom: 2px solid #1f2933; padding-bottom: 12px; margin-bottom: 16px; }
.logo { max-height: 48px; max-width: 160px; margin-bottom: 8px; }
.from-name { font-size: 16px; font-weight: bold; }
.muted { color: #52606d; }
h1 { font-size: 24px; margin: 0 0 8px 0; text-align: right; letter-spacing: 2px; text-transform: uppercase; }
h2 { font-size: 14px; margin: 16px 0 8px 0; }
h3 { font-size: 13px; margin: 0 0 4px 0; }
.meta-table th { text-align: left; padding-right: 12px; color: #52606d; font-weight: normal; }
.label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #52606d; }
.bill-to { margin-bottom: 12px; }
table { border-collapse: collapse; }
.items { width: 100%; margin-bottom: 12px; }
.items th { border-bottom: 1px solid #1f2933; text-align: left; padding: 6px 4px; }
.items td { border-bottom: 1px solid #cbd2d9; padding: 6px 4px; vertical-align: top; }
.num { text-align: right; white-space: nowrap; }
.totals { margin-left: auto; min-width: 240px; }
.totals th { text-align: left; font-weight: normal; padding: 3px 12px 3px 0; }
.grand th, .grand td { font-weight: bold; border-top: 1px solid #1f2933; padding-top: 6px; }
.installments { margin-top: 16px; padding: 8px; border: 1px solid #cbd2d9; }
.schedule td { padding: 2px 12px 2px 0; }
.pay { margin-top: 16px; }
.small { font-size: 10px; color: #52606d; }$css$),
('00000000-0000-4000-8000-00000000c002', NULL, 'Modern', 'builtin', $html$<div class="band">
  <div class="band-left">
    {{#freelancer.logo}}<img class="logo" src="{{freelancer.logo}}" alt="Logo">{{/freelancer.logo}}
    <div class="from-name">{{freelancer.business_name}}{{^freelancer.business_name}}{{freelancer.name}}{{/freelancer.business_name}}</div>
  </div>
  <div class="band-right">
    <div class="title">INVOICE</div>
    <div>{{invoice.number}}</div>
  </div>
</div>
<div class="body">
  <div class="cols">
    <div>
      <div class="label">From</div>
      <div>{{freelancer.name}}</div>
      <div class="muted">{{freelancer.address}}</div>
      <div class="muted">{{freelancer.email}}</div>
    </div>
    <div>
      <div class="label">Bill to</div>
      <div>{{client.name}}</div>
      <div>{{client.company}}</div>
      <div class="muted">{{client.address}}</div>
      <div class="muted">{{client.email}}</div>
    </div>
    <div>
      <div class="label">Dates</div>
      <div>Issued {{invoice.issue_date}}</div>
      <div><strong>Due {{invoice.due_date}}</strong></div>
      <div class="muted">{{invoice.terms}}</div>
    </div>
  </div>
  <p class="lead">{{greeting}}</p>
  <p>{{project_summary}}</p>
  <h2>{{invoice.title}}</h2>
  <table class="items">
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
    <tbody>{{#items}}<tr><td><strong>{{name}}</strong><div class="muted">{{description}}</div></td><td class="num">{{quantity}}</td><td class="num">{{unit_price}}</td><td class="num">{{amount}}</td></tr>{{/items}}</tbody>
  </table>
  <div class="total-box">
    <div>Subtotal <span class="num">{{totals.subtotal}}</span></div>
    <div>Tax <span class="num">{{totals.tax}}</span></div>
    <div>Discount <span class="num">{{totals.discount}}</span></div>
    <div class="grand">Total {{currency}} <span class="num">{{totals.total}}</span></div>
  </div>
  {{#installment.number}}<div class="installments">
    <strong>Installment {{installment.number}} of {{installment.count}}</strong> · Paid so far {{installment.paid_so_far}} · Remaining after this one {{installment.remaining}}
    <ul>{{#installment.schedule}}<li>Installment {{number}}: {{amount}}, {{due_date}} ({{status}})</li>{{/installment.schedule}}</ul>
  </div>{{/installment.number}}
  <a class="pay-button" href="{{invoice.pay_link}}">Pay online</a>
  <div class="small">{{invoice.pay_link}}</div>
  {{#invoice.late_fee_clause}}<p class="small">Late payment: {{invoice.late_fee_clause}}</p>{{/invoice.late_fee_clause}}
  <p>{{notes}}</p>
  <p>{{thank_you_note}}</p>
</div>$html$, $css$@page { size: A4; margin: 0; }
body { font-family: "Helvetica Neue", Arial, sans-serif; color: #102a43; font-size: 12px; line-height: 1.5; margin: 0; }
.band { background-color: #0f766e; color: #ffffff; padding: 24px 18mm; display: flex; justify-content: space-between; align-items: center; }
.logo { max-height: 44px; max-width: 150px; margin-bottom: 6px; }
.from-name { font-size: 18px; font-weight: bold; }
.title { font-size: 26px; font-weight: bold; letter-spacing: 3px; }
.band-right { text-align: right; }
.body { padding: 18px 18mm; }
.cols { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.label { font-size: 10px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; color: #0f766e; }
.muted { color: #627d98; }
.lead { font-size: 13px; }
h2 { font-size: 14px; color: #0f766e; margin: 16px 0 8px 0; }
table { border-collapse: collapse; }
.items { width: 100%; }
.items th { background-color: #e6f4f1; text-align: left; padding: 8px 6px; }
.items td { border-bottom: 1px solid #d9e2ec; padding: 8px 6px; vertical-align: top; }
.num { text-align: right; white-space: nowrap; float: right; }
.items .num { float: none; }
.total-box { margin: 12px 0 0 auto; width: 260px; }
.total-box div { padding: 3px 0; }
.grand { font-size: 15px; font-weight: bold; border-top: 2px solid #0f766e; margin-top: 4px; padding-top: 6px; color: #0f766e; }
.installments { margin-top: 16px; padding: 10px; background-color: #f0f4f8; border-radius: 6px; }
.pay-button { display: inline-block; margin-top: 18px; background-color: #0f766e; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: bold; }
.small { font-size: 10px; color: #627d98; word-break: break-all; }$css$),
('00000000-0000-4000-8000-00000000c003', NULL, 'Minimal', 'builtin', $html$<div class="invoice">
  <div class="top">
    <div>{{freelancer.business_name}}{{^freelancer.business_name}}{{freelancer.name}}{{/freelancer.business_name}}</div>
    <div class="right">Invoice {{invoice.number}}</div>
  </div>
  <div class="spacer"></div>
  <div class="row"><span class="key">To</span><span>{{client.name}}{{#client.company}}, {{client.company}}{{/client.company}}</span></div>
  <div class="row"><span class="key">Issued</span><span>{{invoice.issue_date}}</span></div>
  <div class="row"><span class="key">Due</span><span>{{invoice.due_date}} · {{invoice.terms}}</span></div>
  <div class="spacer"></div>
  <p>{{greeting}}</p>
  <p>{{project_summary}}</p>
  <div class="spacer"></div>
  <div class="row strong"><span class="key">{{invoice.title}}</span><span></span></div>
  {{#items}}<div class="row"><span class="key">{{name}} · {{quantity}} × {{unit_price}}</span><span>{{amount}}</span></div>{{/items}}
  <div class="row rule"><span class="key">Total {{currency}}</span><span>{{totals.total}}</span></div>
  {{#installment.number}}<div class="spacer"></div>
  <p>Installment {{installment.number}} of {{installment.count}}. Paid so far {{installment.paid_so_far}}; remaining after this one {{installment.remaining}}.</p>
  {{#installment.schedule}}<div class="row"><span class="key">Installment {{number}} · {{due_date}}</span><span>{{amount}} ({{status}})</span></div>{{/installment.schedule}}{{/installment.number}}
  <div class="spacer"></div>
  <p>Pay online: <a href="{{invoice.pay_link}}">{{invoice.pay_link}}</a></p>
  {{#invoice.late_fee_clause}}<p class="small">Late payment: {{invoice.late_fee_clause}}</p>{{/invoice.late_fee_clause}}
  <p>{{notes}}</p>
  <p>{{thank_you_note}}</p>
  <div class="spacer"></div>
  <div class="small">{{freelancer.name}} · {{freelancer.email}} · {{freelancer.address}}</div>
</div>$html$, $css$@page { size: A4; margin: 28mm 24mm; }
body { font-family: Arial, sans-serif; color: #222222; font-size: 11px; line-height: 1.7; margin: 0; }
.top { display: flex; justify-content: space-between; font-size: 13px; }
.right { text-align: right; }
.spacer { height: 28px; }
.row { display: flex; justify-content: space-between; padding: 2px 0; }
.key { color: #555555; }
.strong { font-weight: bold; }
.rule { border-top: 1px solid #222222; margin-top: 8px; padding-top: 6px; font-weight: bold; }
.small { font-size: 9px; color: #777777; word-break: break-all; }
a { color: #222222; }$css$);
