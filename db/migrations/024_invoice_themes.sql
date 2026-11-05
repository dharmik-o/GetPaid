-- 024_invoice_themes: three new built-in themes, and every built-in gets the Pay online block with
-- an optional QR code, a signature block and self-hosted fonts (M11, approved 5 Nov 2026).
--
-- Fonts aren't here: lib/document-fonts.ts embeds the families a template's CSS names, so these stay
-- small and pass the same sanitiser as a custom template. None sets a page size: the account's
-- paper setting does, so each fits A4 and US Letter.

ALTER TABLE public.users
  ADD COLUMN invoice_paper text NOT NULL DEFAULT 'A4' CHECK (invoice_paper IN ('A4', 'Letter')),
  ADD COLUMN invoice_show_qr boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.users.invoice_paper IS 'The paper size of this account''s invoice PDFs. A custom template''s own @page size wins.';
COMMENT ON COLUMN public.users.invoice_show_qr IS 'Show a QR code of the pay link on invoice documents.';

-- Classic: formal, in a serif, with a dark table header ----------------------------------------
UPDATE public.invoice_templates SET
html = $html$<div class="page">
  <header class="head">
    <div>
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
        <tr><th>Due</th><td><strong>{{invoice.due_date}}</strong></td></tr>
        <tr><th>Terms</th><td>{{invoice.terms}}</td></tr>
      </table>
    </div>
  </header>
  <section class="bill">
    <div class="box">
      <div class="label">Bill to</div>
      <div class="strong">{{client.name}}</div>
      <div>{{client.company}}</div>
      <div class="muted">{{client.address}}</div>
      <div class="muted">{{client.email}}</div>
    </div>
    <div class="box box-text">
      <div class="label">{{invoice.title}}</div>
      <div>{{greeting}} {{project_summary}}</div>
    </div>
  </section>
  <table class="items">
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
    <tbody>{{#items}}<tr><td><strong>{{name}}</strong><div class="muted small">{{description}}</div></td><td class="num">{{quantity}}</td><td class="num">{{unit_price}}</td><td class="num">{{amount}}</td></tr>{{/items}}</tbody>
  </table>
  <section class="after">
    <div class="after-left">
      {{#installment.number}}<div class="installments">
        <strong>Installment {{installment.number}} of {{installment.count}}</strong>
        <div class="small">Paid so far {{installment.paid_so_far}}. Remaining after this one {{installment.remaining}}.</div>
        <div class="schedule small">{{#installment.schedule}}<span>{{number}}: {{amount}}, {{due_date}} ({{status}})</span>{{/installment.schedule}}</div>
      </div>{{/installment.number}}
      <p class="small">{{notes}}</p>
    </div>
    <table class="totals">
      <tr><th>Subtotal</th><td class="num">{{totals.subtotal}}</td></tr>
      <tr><th>Tax</th><td class="num">{{totals.tax}}</td></tr>
      <tr><th>Discount</th><td class="num">{{totals.discount}}</td></tr>
      <tr class="grand"><th>Total ({{currency}})</th><td class="num">{{totals.total}}</td></tr>
    </table>
  </section>
  <footer class="foot">
    {{#invoice.pay_link}}<section class="pay">
      {{#invoice.pay_qr}}<img class="qr" src="{{invoice.pay_qr}}" alt="QR code for the pay link">{{/invoice.pay_qr}}
      <div>
        <div class="label">Pay online</div>
        <a href="{{invoice.pay_link}}">{{invoice.pay_link}}</a>
      </div>
    </section>{{/invoice.pay_link}}
    <div class="close">
      <div class="close-text">
        {{#invoice.late_fee_clause}}<p class="small muted">Late payment: {{invoice.late_fee_clause}}</p>{{/invoice.late_fee_clause}}
        <p>{{thank_you_note}}</p>
      </div>
      {{#signature}}<div class="signature">
        <img src="{{signature.image}}" alt="Signature">
        <div class="strong">{{signature.name}}</div>
        <div class="small muted">{{signature.title}}</div>
      </div>{{/signature}}
    </div>
  </footer>
</div>$html$,
css = $css$@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "IBM Plex Serif", Georgia, serif; color: #1c2733; font-size: 10.5px; line-height: 1.4; }
.page { display: flex; flex-direction: column; min-height: 100vh; padding: 13mm 15mm; }
.head { display: flex; justify-content: space-between; border-bottom: 3px double #1c2733; padding-bottom: 8px; margin-bottom: 10px; }
.logo { display: block; max-height: 40px; max-width: 150px; margin-bottom: 5px; }
.from-name { font-size: 15px; font-weight: 700; }
.muted { color: #52606d; }
.small { font-size: 9.5px; }
.strong { font-weight: 600; }
h1 { font-size: 28px; font-weight: 600; margin: 0 0 3px 0; text-align: right; }
.meta-table th { text-align: left; padding-right: 12px; color: #52606d; font-weight: 400; }
.meta-table td { text-align: right; }
.label { font-size: 8.5px; font-weight: 600; letter-spacing: 0.08em; color: #52606d; text-transform: uppercase; margin-bottom: 2px; }
.bill { display: flex; gap: 10px; margin-bottom: 10px; }
.box { flex: 1 1 0; border: 1px solid #c9d1d9; padding: 6px 9px; }
.box-text { flex: 1.4 1 0; }
table { border-collapse: collapse; }
.items { width: 100%; }
.items th { background-color: #1c2733; color: #ffffff; text-align: left; font-weight: 600; padding: 4px 7px; }
.items td { border-bottom: 1px solid #c9d1d9; padding: 3px 7px; vertical-align: top; }
.num { text-align: right; white-space: nowrap; }
.items th.num { text-align: right; }
.after { display: flex; justify-content: space-between; gap: 16px; margin-top: 8px; }
.after-left { flex: 1 1 0; }
.after p { margin: 4px 0 0 0; }
.totals { min-width: 210px; align-self: flex-start; }
.totals th { text-align: left; font-weight: 400; padding: 1px 12px 1px 0; }
.grand th, .grand td { font-weight: 700; font-size: 12.5px; border-top: 1px solid #1c2733; border-bottom: 3px double #1c2733; padding: 4px 0; }
.grand th { padding-right: 12px; }
.installments { border-left: 3px solid #1c2733; padding-left: 8px; }
.schedule { display: flex; flex-wrap: wrap; column-gap: 10px; color: #52606d; }
.foot { margin-top: auto; padding-top: 8px; }
.pay { display: flex; align-items: center; gap: 10px; border-top: 1px solid #c9d1d9; padding-top: 7px; }
.qr { width: 58px; height: 58px; }
a { color: #1c2733; word-break: break-all; }
.close { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-top: 6px; }
.close-text p { margin: 2px 0 0 0; }
.signature { flex: none; text-align: right; }
.signature img { display: block; max-height: 38px; max-width: 150px; margin-left: auto; }$css$
WHERE id = '00000000-0000-4000-8000-00000000c001';

-- Modern: as it was, with Pay online, a QR code, a signature and an embedded font ---------------
UPDATE public.invoice_templates SET
html = $html$<div class="page">
<div class="band">
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
  <p class="lead">{{greeting}} {{project_summary}}</p>
  <h2>{{invoice.title}}</h2>
  <table class="items">
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
    <tbody>{{#items}}<tr><td><strong>{{name}}</strong><div class="muted small">{{description}}</div></td><td class="num">{{quantity}}</td><td class="num">{{unit_price}}</td><td class="num">{{amount}}</td></tr>{{/items}}</tbody>
  </table>
  <div class="after">
    <div class="after-left">
      {{#installment.number}}<div class="installments">
        <strong>Installment {{installment.number}} of {{installment.count}}</strong> · Paid so far {{installment.paid_so_far}} · Remaining after this one {{installment.remaining}}
        <div class="schedule small">{{#installment.schedule}}<span>{{number}}: {{amount}}, {{due_date}} ({{status}})</span>{{/installment.schedule}}</div>
      </div>{{/installment.number}}
      <p class="small">{{notes}}</p>
    </div>
    <div class="total-box">
      <div class="line"><span>Subtotal</span><span>{{totals.subtotal}}</span></div>
      <div class="line"><span>Tax</span><span>{{totals.tax}}</span></div>
      <div class="line"><span>Discount</span><span>{{totals.discount}}</span></div>
      <div class="line grand"><span>Total {{currency}}</span><span>{{totals.total}}</span></div>
    </div>
  </div>
  <div class="foot">
    {{#invoice.pay_link}}<section class="pay">
      {{#invoice.pay_qr}}<img class="qr" src="{{invoice.pay_qr}}" alt="QR code for the pay link">{{/invoice.pay_qr}}
      <div>
        <a class="pay-button" href="{{invoice.pay_link}}">Pay online</a>
        <div class="small muted link">{{invoice.pay_link}}</div>
      </div>
    </section>{{/invoice.pay_link}}
    <div class="close">
      <div>
        {{#invoice.late_fee_clause}}<p class="small muted">Late payment: {{invoice.late_fee_clause}}</p>{{/invoice.late_fee_clause}}
        <p>{{thank_you_note}}</p>
      </div>
      {{#signature}}<div class="signature">
        <img src="{{signature.image}}" alt="Signature">
        <div><strong>{{signature.name}}</strong></div>
        <div class="small muted">{{signature.title}}</div>
      </div>{{/signature}}
    </div>
  </div>
</div>
</div>$html$,
css = $css$@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "IBM Plex Sans", Arial, sans-serif; color: #102a43; font-size: 10.5px; line-height: 1.4; }
.page { display: flex; flex-direction: column; min-height: 100vh; }
.band { background-color: #0f766e; color: #ffffff; padding: 16px 15mm; display: flex; justify-content: space-between; align-items: center; }
.logo { display: block; max-height: 38px; max-width: 150px; margin-bottom: 4px; }
.from-name { font-size: 17px; font-weight: 700; }
.title { font-size: 25px; font-weight: 700; letter-spacing: 3px; }
.band-right { text-align: right; }
.body { flex: 1 1 auto; display: flex; flex-direction: column; padding: 10px 15mm 11mm 15mm; }
.cols { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 7px; }
.label { font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #0f766e; }
.muted { color: #52667a; }
.small { font-size: 9.5px; }
.lead { margin: 0 0 6px 0; }
h2 { font-size: 13px; font-weight: 600; color: #0f766e; margin: 0 0 4px 0; }
table { border-collapse: collapse; }
.items { width: 100%; }
.items th { background-color: #e6f4f1; text-align: left; padding: 4px 6px; }
.items td { border-bottom: 1px solid #d9e2ec; padding: 3px 6px; vertical-align: top; }
.items .num { text-align: right; white-space: nowrap; }
.after { display: flex; justify-content: space-between; gap: 16px; margin-top: 7px; }
.after-left { flex: 1 1 0; }
.after-left p { margin: 4px 0 0 0; }
.total-box { flex: none; width: 240px; }
.line { display: flex; justify-content: space-between; padding: 1px 0; }
.grand { font-size: 14px; font-weight: 700; border-top: 2px solid #0f766e; margin-top: 3px; padding-top: 4px; color: #0f766e; }
.installments { padding: 6px 8px; background-color: #f0f4f8; border-radius: 6px; }
.schedule { display: flex; flex-wrap: wrap; column-gap: 10px; }
.foot { margin-top: auto; padding-top: 8px; }
.pay { display: flex; align-items: center; gap: 12px; }
.qr { width: 58px; height: 58px; }
.pay-button { display: inline-block; background-color: #0f766e; color: #ffffff; padding: 5px 14px; border-radius: 6px; text-decoration: none; font-weight: 700; }
.link { word-break: break-all; margin-top: 3px; }
.close { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-top: 5px; }
.close p { margin: 2px 0 0 0; }
.signature { flex: none; text-align: right; }
.signature img { display: block; max-height: 38px; max-width: 150px; margin-left: auto; }$css$
WHERE id = '00000000-0000-4000-8000-00000000c002';

-- Minimal: lots of air, one hairline, and a large total -----------------------------------------
UPDATE public.invoice_templates SET
html = $html$<div class="page">
  <header class="top">
    <div>
      {{#freelancer.logo}}<img class="logo" src="{{freelancer.logo}}" alt="Logo">{{/freelancer.logo}}
      <div class="name">{{freelancer.business_name}}{{^freelancer.business_name}}{{freelancer.name}}{{/freelancer.business_name}}</div>
    </div>
    <div class="right">
      <div class="number">{{invoice.number}}</div>
      <div class="key">Invoice</div>
    </div>
  </header>
  <section class="facts">
    <div><div class="key">To</div><div>{{client.name}}</div><div>{{client.company}}</div><div class="key">{{client.address}}</div><div class="key">{{client.email}}</div></div>
    <div><div class="key">From</div><div>{{freelancer.name}}</div><div class="key">{{freelancer.address}}</div><div class="key">{{freelancer.email}}</div></div>
    <div><div class="key">Issued</div><div>{{invoice.issue_date}}</div><div class="key gap">Due</div><div>{{invoice.due_date}}</div><div class="key">{{invoice.terms}}</div></div>
  </section>
  <p class="text">{{greeting}} {{project_summary}}</p>
  <div class="title">{{invoice.title}}</div>
  <div class="rows">
    {{#items}}<div class="row"><div class="row-name">{{name}}<div class="key small">{{description}}</div></div><div class="key qty">{{quantity}} × {{unit_price}}</div><div class="amount">{{amount}}</div></div>{{/items}}
  </div>
  <section class="sum">
    <div class="sum-left">
      {{#installment.number}}<div class="small">
        <strong>Installment {{installment.number}} of {{installment.count}}.</strong> Paid so far {{installment.paid_so_far}}; remaining after this one {{installment.remaining}}.
        <div class="schedule key">{{#installment.schedule}}<span>{{number}}: {{amount}}, {{due_date}} ({{status}})</span>{{/installment.schedule}}</div>
      </div>{{/installment.number}}
      <p class="small">{{notes}}</p>
    </div>
    <div class="sum-right">
      <div class="line key"><span>Subtotal</span><span>{{totals.subtotal}}</span></div>
      <div class="line key"><span>Tax</span><span>{{totals.tax}}</span></div>
      <div class="line key"><span>Discount</span><span>{{totals.discount}}</span></div>
      <div class="key total-label">Total {{currency}}</div>
      <div class="total">{{totals.total}}</div>
    </div>
  </section>
  <footer class="foot">
    {{#invoice.pay_link}}<section class="pay">
      {{#invoice.pay_qr}}<img class="qr" src="{{invoice.pay_qr}}" alt="QR code for the pay link">{{/invoice.pay_qr}}
      <div><div class="strong">Pay online</div><a href="{{invoice.pay_link}}">{{invoice.pay_link}}</a></div>
    </section>{{/invoice.pay_link}}
    <div class="close">
      <div>
        {{#invoice.late_fee_clause}}<p class="key small">Late payment: {{invoice.late_fee_clause}}</p>{{/invoice.late_fee_clause}}
        <p class="small">{{thank_you_note}}</p>
      </div>
      {{#signature}}<div class="signature">
        <img src="{{signature.image}}" alt="Signature">
        <div class="small">{{signature.name}}</div>
        <div class="key small">{{signature.title}}</div>
      </div>{{/signature}}
    </div>
  </footer>
</div>$html$,
css = $css$@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "Instrument Sans", Arial, sans-serif; color: #1a1a1a; font-size: 10.5px; line-height: 1.4; }
.page { display: flex; flex-direction: column; min-height: 100vh; padding: 14mm 18mm 12mm 18mm; }
.top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
.logo { display: block; max-height: 34px; max-width: 130px; margin-bottom: 4px; }
.name { font-size: 15px; font-weight: 600; }
.right { text-align: right; }
.number { font-size: 15px; font-weight: 600; }
.key { color: #6b6b6b; }
.gap { margin-top: 3px; }
.small { font-size: 9.5px; }
.strong { font-weight: 600; }
.facts { display: flex; gap: 24px; margin-bottom: 10px; }
.facts > div { flex: 1 1 0; }
.text { margin: 0 0 10px 0; max-width: 36em; }
.title { font-weight: 600; padding-bottom: 3px; border-bottom: 1px solid #1a1a1a; }
.row { display: flex; gap: 14px; padding: 2px 0; align-items: baseline; }
.row-name { flex: 1 1 auto; }
.qty { flex: none; white-space: nowrap; }
.amount { flex: none; width: 92px; text-align: right; white-space: nowrap; }
.sum { display: flex; justify-content: space-between; gap: 24px; margin-top: 8px; padding-top: 7px; border-top: 1px solid #1a1a1a; }
.sum-left { flex: 1 1 0; }
.sum-left p { margin: 3px 0 0 0; }
.sum-right { flex: none; width: 230px; }
.line { display: flex; justify-content: space-between; }
.total-label { margin-top: 4px; text-align: right; }
.total { font-size: 28px; font-weight: 600; line-height: 1.1; text-align: right; white-space: nowrap; }
.schedule { display: flex; flex-wrap: wrap; column-gap: 10px; }
.foot { margin-top: auto; padding-top: 8px; }
.pay { display: flex; align-items: center; gap: 12px; }
.qr { width: 58px; height: 58px; }
a { color: #1a1a1a; word-break: break-all; }
.close { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-top: 5px; }
.close p { margin: 2px 0 0 0; }
.signature { flex: none; text-align: right; }
.signature img { display: block; max-height: 34px; max-width: 140px; margin-left: auto; }$css$
WHERE id = '00000000-0000-4000-8000-00000000c003';

-- The three new themes --------------------------------------------------------------------------
INSERT INTO public.invoice_templates (id, user_id, name, kind, html, css) VALUES
-- Studio: a clean agency sheet, with rotated strips down the right edge.
('00000000-0000-4000-8000-00000000c004', NULL, 'Studio', 'builtin', $html$<div class="page">
  <header class="top">
    <div class="brand">
      {{#freelancer.logo}}<img class="logo" src="{{freelancer.logo}}" alt="Logo">{{/freelancer.logo}}
      <div class="brand-name">{{freelancer.business_name}}{{^freelancer.business_name}}{{freelancer.name}}{{/freelancer.business_name}}</div>
      <div class="muted small">{{freelancer.name}}</div>
    </div>
    <div class="contact">
      <div class="muted small">{{freelancer.email}}</div>
      <div class="muted small">{{freelancer.address}}</div>
      <div class="to-label muted">Invoice to</div>
      <div class="to-name">{{client.company}}{{^client.company}}{{client.name}}{{/client.company}}</div>
      <div class="muted small">{{client.name}}</div>
      <div class="muted small">{{client.address}}</div>
      <div class="muted small">{{client.email}}</div>
    </div>
  </header>
  {{#invoice.pay_link}}<aside class="strip strip-pay">
    <div class="strip-title">Pay online</div>
    <a href="{{invoice.pay_link}}">{{invoice.pay_link}}</a>
  </aside>{{/invoice.pay_link}}
  <aside class="strip strip-terms">
    <div class="strip-title">Terms</div>
    <div>{{invoice.terms}}. Due {{invoice.due_date}}.</div>
  </aside>
  <div class="body">
    <h1>Invoice</h1>
    <div class="muted small">Invoice {{invoice.number}}</div>
    <div class="muted small">{{invoice.issue_date}}</div>
    <p class="text">{{greeting}} {{project_summary}}</p>
    <table class="items">
      <thead><tr><th>Description</th><th class="center">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
      <tbody>{{#items}}<tr><td><strong>{{name}}</strong><div class="muted small">{{description}}</div></td><td class="center">{{quantity}}</td><td class="num">{{unit_price}}</td><td class="num">{{amount}}</td></tr>{{/items}}</tbody>
    </table>
    <section class="after">
      <div class="totals">
        <div class="line muted"><span>Subtotal</span><span>{{totals.subtotal}}</span></div>
        <div class="line muted"><span>Tax</span><span>{{totals.tax}}</span></div>
        <div class="line muted"><span>Discount</span><span>{{totals.discount}}</span></div>
        <div class="line grand"><span>Grand total</span><span>{{totals.total}}</span></div>
        <div class="hatch"></div>
        <div class="muted small">{{invoice.title}}. All amounts in {{currency}}.</div>
      </div>
      <div class="side">
        {{#installment.number}}<div>
          <strong>Installment {{installment.number}} of {{installment.count}}</strong>
          <div class="small">Paid so far {{installment.paid_so_far}}. Remaining after this one {{installment.remaining}}.</div>
          <div class="schedule muted small">{{#installment.schedule}}<span>{{number}}: {{amount}}, {{due_date}} ({{status}})</span>{{/installment.schedule}}</div>
        </div>{{/installment.number}}
        <p class="small">{{notes}}</p>
        {{#invoice.late_fee_clause}}<p class="small muted">Late payment: {{invoice.late_fee_clause}}</p>{{/invoice.late_fee_clause}}
      </div>
    </section>
  </div>
  <footer class="foot">
    <div class="foot-left">
      {{#signature}}<div class="signature">
        <div class="sig-name">{{signature.name}}</div>
        <div class="muted small">{{signature.title}}</div>
        <img src="{{signature.image}}" alt="Signature">
      </div>{{/signature}}
    </div>
    <div class="foot-right">
      <div class="thanks">
        <div class="thanks-big">Thank you for your business</div>
        <div class="muted small">{{thank_you_note}}</div>
      </div>
      {{#invoice.pay_qr}}<img class="qr" src="{{invoice.pay_qr}}" alt="QR code for the pay link">{{/invoice.pay_qr}}
    </div>
  </footer>
</div>$html$, $css$@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "Instrument Sans", Arial, sans-serif; color: #1a1a1a; font-size: 10.5px; line-height: 1.4; }
.page { position: relative; display: flex; flex-direction: column; min-height: 100vh; padding: 13mm 14mm 11mm 14mm; }
.top { display: flex; justify-content: space-between; align-items: flex-start; }
.logo { display: block; max-height: 42px; max-width: 150px; margin-bottom: 4px; }
.brand-name { font-size: 13px; font-weight: 700; }
.contact { text-align: right; }
.to-label { margin-top: 6px; font-size: 9.5px; }
.to-name { font-size: 13px; font-weight: 700; }
.muted { color: #666666; }
.small { font-size: 9.5px; }
.body { margin-right: 25mm; }
h1 { font-size: 30px; font-weight: 600; line-height: 1.1; margin: 8px 0 2px 0; }
.text { margin: 5px 0 7px 0; }
table { border-collapse: collapse; }
.items { width: 100%; }
.items th { background-color: #e4e4e4; text-align: left; font-weight: 500; padding: 4px 6px; }
.items td { border-bottom: 1px solid #8a8a8a; padding: 3px 6px; vertical-align: top; }
.items th.num, .items .num { text-align: right; white-space: nowrap; }
.center { text-align: center; }
.items th.center { text-align: center; }
.after { display: flex; gap: 20px; margin-top: 8px; }
.totals { flex: none; width: 215px; }
.line { display: flex; justify-content: space-between; padding: 1px 0; }
.grand { font-size: 13px; font-weight: 700; margin-top: 3px; color: #1a1a1a; }
.hatch { height: 5px; margin: 3px 0 4px 0; background-image: repeating-linear-gradient(115deg, #8a8a8a 0, #8a8a8a 1px, #ffffff 1px, #ffffff 3px); }
.side { flex: 1 1 0; }
.side p { margin: 3px 0 0 0; }
.schedule { display: flex; flex-wrap: wrap; column-gap: 9px; }
.strip { position: absolute; right: 14mm; width: 20mm; writing-mode: vertical-rl; transform: rotate(180deg); font-size: 8.5px; line-height: 1.3; }
.strip-pay { top: 62mm; height: 92mm; border-right: 1px solid #1a1a1a; padding-right: 2mm; }
.strip-terms { top: 160mm; height: 50mm; border-right: 1px solid #1a1a1a; padding-right: 2mm; }
.strip-title { font-weight: 700; }
a { color: #1a1a1a; word-break: break-all; }
.foot { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-top: auto; padding-top: 8px; }
.sig-name { font-weight: 700; }
.signature img { display: block; max-height: 38px; max-width: 150px; margin-top: 2px; }
.foot-right { display: flex; align-items: flex-end; gap: 10px; text-align: right; }
.thanks-big { font-size: 12px; font-weight: 600; }
.qr { width: 62px; height: 62px; }$css$),
-- Ledger: warm paper, all capitals, a typewriter's table.
('00000000-0000-4000-8000-00000000c005', NULL, 'Ledger', 'builtin', $html$<div class="page">
  <header class="head">
    <div class="from">
      {{#freelancer.logo}}<img class="logo" src="{{freelancer.logo}}" alt="Logo">{{/freelancer.logo}}
      <div>{{freelancer.business_name}}{{^freelancer.business_name}}{{freelancer.name}}{{/freelancer.business_name}}</div>
      <div>{{freelancer.name}}</div>
      <div>{{freelancer.email}}</div>
      <div>{{freelancer.address}}</div>
    </div>
    <h1>Invoice</h1>
  </header>
  <section class="cells">
    <div class="cell">
      <div>Invoice no. {{invoice.number}}</div>
      <div>Issued {{invoice.issue_date}}</div>
      <div>Due {{invoice.due_date}}</div>
    </div>
    <div class="cell cell-right">
      <div>Billed to {{client.name}}</div>
      <div>{{client.company}}</div>
      <div>{{client.address}}</div>
      <div>{{client.email}}</div>
    </div>
  </section>
  <p class="text">{{greeting}} {{project_summary}}</p>
  <div class="title">{{invoice.title}}</div>
  <table class="items">
    <thead><tr><th>Item</th><th>Rate</th><th>Qty</th><th class="num">Total</th></tr></thead>
    <tbody>{{#items}}<tr><td>{{name}}<div class="note">{{description}}</div></td><td class="nowrap">{{unit_price}}</td><td>{{quantity}}</td><td class="num">{{amount}}</td></tr>{{/items}}</tbody>
  </table>
  <section class="after">
    <div class="after-left">
      {{#installment.number}}<div>Installment {{installment.number}} of {{installment.count}}
        <div class="note">Paid so far {{installment.paid_so_far}}. Remaining after this one {{installment.remaining}}.</div>
        <div class="schedule note">{{#installment.schedule}}<span>{{number}}: {{amount}}, {{due_date}} ({{status}})</span>{{/installment.schedule}}</div>
      </div>{{/installment.number}}
      <div class="note">{{notes}}</div>
      {{#signature}}<div class="signature">
        <img src="{{signature.image}}" alt="Signature">
        <div>{{signature.name}}</div>
        <div class="note">{{signature.title}}</div>
      </div>{{/signature}}
    </div>
    <div class="totals">
      <div class="line"><span>Subtotal</span><span>{{totals.subtotal}}</span></div>
      <div class="line"><span>Tax</span><span>{{totals.tax}}</span></div>
      <div class="line"><span>Discount</span><span>{{totals.discount}}</span></div>
      <div class="line grand"><span>Total {{currency}}</span><span>{{totals.total}}</span></div>
    </div>
  </section>
  <footer class="foot">
    {{#invoice.pay_link}}<section class="pay">
      <div class="pay-grid">
        <div class="pay-text">
          <div>Pay online</div>
          <a href="{{invoice.pay_link}}">{{invoice.pay_link}}</a>
        </div>
        {{#invoice.pay_qr}}<img class="qr" src="{{invoice.pay_qr}}" alt="QR code for the pay link">{{/invoice.pay_qr}}
      </div>
    </section>{{/invoice.pay_link}}
    <div class="close">
      <div class="terms">
        <div>Payment terms: {{invoice.terms}}.</div>
        {{#invoice.late_fee_clause}}<div>Late payment: {{invoice.late_fee_clause}}</div>{{/invoice.late_fee_clause}}
      </div>
      <div class="thanks">{{thank_you_note}}</div>
    </div>
  </footer>
</div>$html$, $css$@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background-color: #F3F0EA; }
body { font-family: "IBM Plex Mono", "Courier New", monospace; color: #1f1f1d; font-size: 9.5px; line-height: 1.35; text-transform: uppercase; }
.page { display: flex; flex-direction: column; min-height: 100vh; padding: 12mm 15mm 11mm 15mm; background-color: #F3F0EA; }
.head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
.logo { display: block; max-height: 30px; max-width: 120px; margin-bottom: 4px; }
.from { font-size: 8.5px; }
h1 { font-family: "IBM Plex Sans", Arial, sans-serif; font-size: 38px; font-weight: 600; line-height: 1; margin: 0; text-align: right; }
.cells { display: flex; border-top: 1px solid #55554f; border-bottom: 1px solid #55554f; }
.cell { flex: 1 1 0; padding: 7px 0; }
.cell-right { border-left: 1px solid #55554f; text-align: right; }
.text { margin: 8px 0 4px 0; font-size: 8.5px; }
.title { font-weight: 500; margin-bottom: 7px; }
table { border-collapse: collapse; }
.items { width: 100%; }
.items th { text-align: left; font-weight: 500; padding: 0 8px 5px 0; border-bottom: 1px solid #55554f; }
.items td { padding: 3px 8px 0 0; vertical-align: top; }
.items th.num, .items td.num { text-align: right; padding-right: 0; white-space: nowrap; }
.nowrap { white-space: nowrap; }
.note { font-size: 8px; color: #55554f; }
.after { display: flex; justify-content: space-between; gap: 20px; margin-top: 7px; padding-top: 7px; border-top: 1px solid #55554f; }
.after-left { flex: 1 1 0; }
.totals { flex: none; width: 245px; }
.line { display: flex; justify-content: space-between; padding: 1px 0; }
.grand { margin-top: 5px; font-weight: 600; }
.schedule { display: flex; flex-wrap: wrap; column-gap: 10px; }
.signature { margin-top: 5px; }
.signature img { display: block; max-height: 34px; max-width: 140px; }
.foot { margin-top: auto; padding-top: 7px; border-top: 1px solid #55554f; }
.pay-grid { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
.pay-text a { display: block; color: #1f1f1d; text-transform: none; word-break: break-all; margin-top: 2px; }
.qr { flex: none; width: 56px; height: 56px; }
.close { display: flex; justify-content: space-between; gap: 24px; margin-top: 5px; font-size: 8px; }
.terms { flex: 1 1 0; }
.thanks { flex: 0 1 45%; text-align: right; }$css$),
-- Noir: a dark charcoal page with light text and a very large total.
('00000000-0000-4000-8000-00000000c006', NULL, 'Noir', 'builtin', $html$<div class="page">
  <div class="logo-square">{{#freelancer.logo}}<img class="logo" src="{{freelancer.logo}}" alt="Logo">{{/freelancer.logo}}{{^freelancer.logo}}<div class="logo-dot"></div>{{/freelancer.logo}}</div>
  <header class="head">
    <h1>Invoice</h1>
    <div class="grid mono">
      <div class="grid-row"><span>Invoice number</span><span>{{invoice.number}}</span></div>
      <div class="grid-row"><span>Issue date</span><span>{{invoice.issue_date}}</span></div>
      <div class="grid-row"><span>Due date</span><span>{{invoice.due_date}}</span></div>
    </div>
  </header>
  <section class="cols">
    <div class="col">
      <div class="label">From</div>
      <div>{{freelancer.business_name}}{{^freelancer.business_name}}{{freelancer.name}}{{/freelancer.business_name}}</div>
      <div>{{freelancer.name}}</div>
      <div>{{freelancer.address}}</div>
      <div>{{freelancer.email}}</div>
    </div>
    <div class="col">
      <div class="label">Bill to</div>
      <div>{{client.name}}</div>
      <div>{{client.company}}</div>
      <div>{{client.address}}</div>
      <div>{{client.email}}</div>
    </div>
  </section>
  <p class="text">{{greeting}} {{project_summary}}</p>
  <div class="title">{{invoice.title}}</div>
  <table class="items mono">
    <thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th class="num">Amount</th></tr></thead>
    <tbody>{{#items}}<tr><td>{{name}}<div class="note">{{description}}</div></td><td>{{quantity}}</td><td class="nowrap">{{unit_price}}</td><td class="num">{{amount}}</td></tr>{{/items}}</tbody>
  </table>
  <section class="after">
    <div class="after-left">
      {{#installment.number}}<div>
        Installment {{installment.number}} of {{installment.count}}
        <div class="note">Paid so far {{installment.paid_so_far}}. Remaining after this one {{installment.remaining}}.</div>
        <div class="schedule note">{{#installment.schedule}}<span>{{number}}: {{amount}}, {{due_date}} ({{status}})</span>{{/installment.schedule}}</div>
      </div>{{/installment.number}}
    </div>
    <div class="sums mono">
      <div class="line"><span>Subtotal</span><span>{{totals.subtotal}}</span></div>
      <div class="line"><span>Discount</span><span>-{{totals.discount}}</span></div>
      <div class="line"><span>Tax</span><span>{{totals.tax}}</span></div>
    </div>
  </section>
  <div class="grand">
    <div class="grand-label">Total {{currency}}</div>
    <div class="grand-value mono">{{totals.total}}</div>
  </div>
  <footer class="foot">
    <div class="foot-col">
      {{#invoice.pay_link}}<section class="pay">
        <div class="label">Pay online</div>
        <div class="pay-row">
          {{#invoice.pay_qr}}<img class="qr" src="{{invoice.pay_qr}}" alt="QR code for the pay link">{{/invoice.pay_qr}}
          <a href="{{invoice.pay_link}}">{{invoice.pay_link}}</a>
        </div>
      </section>{{/invoice.pay_link}}
    </div>
    <div class="foot-col">
      <div class="label">Notes</div>
      <div class="note">{{invoice.terms}}. {{notes}}</div>
      {{#invoice.late_fee_clause}}<div class="note">Late payment: {{invoice.late_fee_clause}}</div>{{/invoice.late_fee_clause}}
      <div class="note">{{thank_you_note}}</div>
      {{#signature}}<div class="signature">
        <img src="{{signature.image}}" alt="Signature">
        <div class="sig-text"><div>{{signature.name}}</div><div class="note">{{signature.title}}</div></div>
      </div>{{/signature}}
    </div>
  </footer>
</div>$html$, $css$@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background-color: #1E1E1E; }
body { font-family: "IBM Plex Sans", Arial, sans-serif; color: #f1f1f1; font-size: 10px; line-height: 1.38; }
.mono { font-family: "IBM Plex Mono", "Courier New", monospace; }
.page { display: flex; flex-direction: column; min-height: 100vh; padding: 11mm 14mm 10mm 14mm; background: linear-gradient(180deg, #1E1E1E 0%, #4A4A4A 100%); }
.logo-square { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; background-color: #ffffff; }
.logo { max-width: 34px; max-height: 34px; }
.logo-dot { width: 15px; height: 15px; border-radius: 50%; background-color: #1E1E1E; }
.head { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 8px; }
h1 { font-size: 42px; font-weight: 300; line-height: 1; margin: 0; }
.grid { flex: 0 0 50%; font-size: 9.5px; }
.grid-row { display: flex; justify-content: space-between; padding: 1px 0; }
.cols { display: flex; margin-top: 10px; }
.col { flex: 0 0 50%; }
.label { color: #cfcfcf; margin-bottom: 2px; }
.text { margin: 8px 0 2px 0; color: #dcdcdc; }
.title { color: #cfcfcf; margin-bottom: 5px; }
table { border-collapse: collapse; }
.items { width: 100%; font-size: 9.5px; }
.items th { text-align: left; font-weight: 400; color: #e4e4e4; padding: 0 8px 3px 0; border-bottom: 1px solid #7c7c7c; }
.items td { padding: 2px 8px 1px 0; vertical-align: top; }
.items th.num, .items td.num { text-align: right; padding-right: 0; white-space: nowrap; }
.nowrap { white-space: nowrap; }
.note { font-size: 8.5px; color: #d0d0d0; }
.after { display: flex; gap: 20px; margin-top: 4px; padding-top: 4px; border-top: 1px solid #7c7c7c; }
.after-left { flex: 1 1 0; }
.sums { flex: 0 0 46%; }
.line { display: flex; justify-content: space-between; padding: 1px 0; }
.schedule { display: flex; flex-wrap: wrap; column-gap: 9px; }
.grand { display: flex; justify-content: space-between; align-items: center; margin-top: auto; padding: 5px 0; border-top: 1px solid #8c8c8c; border-bottom: 1px solid #8c8c8c; }
.grand-label { color: #e4e4e4; }
.grand-value { font-size: 34px; font-weight: 400; line-height: 1.1; white-space: nowrap; }
.foot { display: flex; padding-top: 7px; }
.foot-col { flex: 0 0 50%; padding-right: 12px; }
.pay-row { display: flex; align-items: center; gap: 9px; }
.qr { flex: none; width: 56px; height: 56px; }
a { color: #f1f1f1; word-break: break-all; font-size: 8.5px; }
.signature { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.signature img { display: block; max-height: 32px; max-width: 120px; padding: 2px 5px; background-color: #ffffff; }$css$);
