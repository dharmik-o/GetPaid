"use client";

// "Include my signature" wherever an invoice is created. It starts from the account's default, and
// the choice is stored on the invoice. With no signature set up, it says where to add one.

export type SignatureChoice = { available: boolean; byDefault: boolean };

export const NO_SIGNATURE: SignatureChoice = { available: false, byDefault: false };

/** What the checkbox starts as: nothing to include means off, whatever the default says. */
export const startsTicked = ({ available, byDefault }: SignatureChoice): boolean =>
  available && byDefault;

type Props = {
  available: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

export const IncludeSignature = ({ available, checked, onChange }: Props) => (
  <div className="include-signature">
    <label className="inline">
      <input
        type="checkbox"
        checked={available && checked}
        disabled={!available}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />{" "}
      Include my signature
    </label>
    {available ? null : (
      <div className="field-hint">Add a signature in Settings &gt; Invoice templates first.</div>
    )}
  </div>
);
