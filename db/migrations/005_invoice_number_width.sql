-- 005_invoice_number_width: invoice numbers keep every digit.
-- 004's default used lpad(n, 6), which cuts numbers longer than six digits (1000000 became
-- 100000), so numbers would repeat after invoice 999,999. A repeated number would make PayPal
-- refuse the invoice, or let a retry pick up the wrong one. Pad to at least six digits instead.

CREATE FUNCTION public.next_invoice_number() RETURNS text
  LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT 'FPR-' || lpad(n::text, greatest(6, length(n::text)), '0')
  FROM nextval('public.invoice_number_seq') AS n
$$;

REVOKE ALL ON FUNCTION public.next_invoice_number() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_invoice_number() TO authenticated, service_role;

ALTER TABLE public.invoices ALTER COLUMN invoice_number SET DEFAULT public.next_invoice_number();
