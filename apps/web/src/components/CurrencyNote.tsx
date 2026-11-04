// Goes under every currency dropdown, because a freelancer in India looks for INR first.

const NOTE =
  "INR isn't listed because PayPal can't receive rupee payments. Bill in your client's currency, and PayPal converts to INR when you withdraw.";

export const CurrencyNote = ({ id }: { id: string }) => (
  <div id={id} className="field-hint">
    {NOTE}
  </div>
);
