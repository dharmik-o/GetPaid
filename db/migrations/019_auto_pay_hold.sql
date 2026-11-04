-- 019_auto_pay_hold: after a failed auto-pay charge the subscription is suspended in PayPal before
-- any catch-up invoice exists, and reactivated once that invoice is paid, so the client can't be
-- charged by PayPal and pay the invoice for the same charge.
--
-- auto_pay_hold_cycle_on: the charge that failed. Set: a hold is in progress.
-- auto_pay_held_at: PayPal confirmed the suspension. Only then may the invoice exist.
-- Saving each step means a PayPal failure leaves something the scheduler can finish.

ALTER TABLE public.retainers
  ADD COLUMN auto_pay_hold_cycle_on date,
  ADD COLUMN auto_pay_held_at timestamptz,
  ADD CONSTRAINT retainers_held_only_with_a_cycle
    CHECK (auto_pay_held_at IS NULL OR auto_pay_hold_cycle_on IS NOT NULL);

COMMENT ON COLUMN public.retainers.auto_pay_hold_cycle_on IS 'The failed charge being recovered by invoice. Set: a hold is in progress.';
COMMENT ON COLUMN public.retainers.auto_pay_held_at IS 'When PayPal confirmed the suspension. The catch-up invoice is created only after this.';

ALTER TABLE public.retainer_alerts
  DROP CONSTRAINT retainer_alerts_kind_check,
  ADD CONSTRAINT retainer_alerts_kind_check CHECK (kind IN (
    'payment_failed', 'suspended', 'cancelled', 'recovered', 'reactivated', 'paid_twice',
    'activated_after_cancel'
  ));
