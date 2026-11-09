"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { sendJson } from "@/lib/api-client";

// The freelancer's legal name, Udyam (MSME) number and governing-law country (Settings).

type Props = {
  current: {
    legalName: string | null;
    udyamNumber: string | null;
    governingLawCountry: string | null;
  };
  countries: { code: string; name: string }[];
};

export const LegalFactsForm = ({ current, countries }: Props) => {
  const router = useRouter();
  const [legalName, setLegalName] = useState(current.legalName ?? "");
  const [udyamNumber, setUdyamNumber] = useState(current.udyamNumber ?? "");
  const [country, setCountry] = useState(current.governingLawCountry ?? "");
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await sendJson(
      "/api/settings/account",
      "PUT",
      {
        legalName: legalName.trim() || null,
        udyamNumber: udyamNumber.trim() || null,
        governingLawCountry: country || null,
      },
      {
        legalName: "Legal name",
        udyamNumber: "Udyam number",
        governingLawCountry: "Governing law country",
      },
    );
    setBusy(false);
    setMessage(result.ok ? { ok: true, text: "Saved." } : { ok: false, text: result.message });
    if (result.ok) router.refresh();
  };

  return (
    <form
      className="form"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <div className="field">
        <label htmlFor="legal-name">Legal name</label>
        <input
          id="legal-name"
          value={legalName}
          maxLength={160}
          onChange={(e) => {
            setLegalName(e.target.value);
          }}
        />
        <div className="field-hint">
          Your name, or your company&apos;s, as it appears in contracts.
        </div>
      </div>
      <div className="field">
        <label htmlFor="udyam-number">Udyam (MSME) number</label>
        <input
          id="udyam-number"
          value={udyamNumber}
          placeholder="UDYAM-MH-12-1234567"
          onChange={(e) => {
            setUdyamNumber(e.target.value);
          }}
        />
        <div className="field-hint">Only if you have one. India&apos;s MSMED Act needs it.</div>
      </div>
      <div className="field">
        <label htmlFor="governing-law">Country whose law governs your contracts</label>
        <select
          id="governing-law"
          value={country}
          onChange={(e) => {
            setCountry(e.target.value);
          }}
        >
          <option value="">Not set</option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {message ? (
        <p className={message.ok ? "field-hint" : "banner banner-error"} role="status">
          {message.text}
        </p>
      ) : null}
      <div className="actions">
        <button className="button" type="submit" disabled={busy}>
          Save legal details
        </button>
      </div>
    </form>
  );
};
