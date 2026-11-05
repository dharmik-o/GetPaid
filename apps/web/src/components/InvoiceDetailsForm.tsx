"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { sendJson } from "@/lib/api-client";
import { SIGNATURE_DISCLAIMER, SIGNATURE_MAX_BYTES, SIGNATURE_TYPES } from "@/lib/signature-rules";

// Your details on every invoice document: business name, address, logo, paper size and whether
// to show a QR code of the pay link. The logo is kept as an embedded image, so a PDF never loads
// anything from the network.

/** Not the default template: that's set from the gallery above, separately. */
type Details = {
  businessName: string | null;
  address: string | null;
  logoDataUrl: string | null;
  invoicePaper: "A4" | "Letter";
  invoiceShowQr: boolean;
  signatureSource: "upload" | "typed" | null;
  signatureImageDataUrl: string | null;
  signatureTypedName: string | null;
  signatureName: string | null;
  signatureTitle: string | null;
  signatureDefault: boolean;
};

const LOGO_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const LOGO_MAX_BYTES = 200 * 1024;

const NAMES = {
  businessName: "Business name",
  address: "Address",
  logoDataUrl: "Logo",
  invoicePaper: "Paper size",
  invoiceShowQr: "QR code",
  signatureImageDataUrl: "Signature image",
  signatureTypedName: "Typed name",
  signatureName: "Signer's name",
  signatureTitle: "Signer's title",
};

const SOURCES: { value: Details["signatureSource"]; label: string }[] = [
  { value: null, label: "No signature" },
  { value: "upload", label: "Upload an image" },
  { value: "typed", label: "Type my name" },
];

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => {
      reject(new Error("unreadable"));
    };
    reader.readAsDataURL(file);
  });

export const InvoiceDetailsForm = ({ initial, name }: { initial: Details; name: string }) => {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean }>();

  const pickLogo = async (file: File | undefined) => {
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) {
      setMessage({ text: "Logo must be a PNG, JPEG, GIF or WebP image.", error: true });
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setMessage({ text: "Logo is too large: use an image under 200 KB.", error: true });
      return;
    }
    try {
      const logoDataUrl = await readAsDataUrl(file);
      setValues((v) => ({ ...v, logoDataUrl }));
      setMessage(undefined);
    } catch {
      setMessage({ text: "That image couldn't be read. Try another file.", error: true });
    }
  };

  const pickSignature = async (file: File | undefined) => {
    if (!file) return;
    if (!SIGNATURE_TYPES.includes(file.type)) {
      setMessage({ text: "Signature must be a PNG or JPG image.", error: true });
      return;
    }
    if (file.size > SIGNATURE_MAX_BYTES) {
      setMessage({ text: "Signature is too large: use an image under 500 KB.", error: true });
      return;
    }
    try {
      const signatureImageDataUrl = await readAsDataUrl(file);
      setValues((v) => ({ ...v, signatureImageDataUrl }));
      setMessage(undefined);
    } catch {
      setMessage({ text: "That image couldn't be read. Try another file.", error: true });
    }
  };

  /** What the signature looks like now: a typed one is drawn on saving, then comes back. */
  const signaturePreview =
    values.signatureSource === "upload"
      ? values.signatureImageDataUrl
      : values.signatureSource === "typed" &&
          initial.signatureSource === "typed" &&
          initial.signatureTypedName === values.signatureTypedName
        ? initial.signatureImageDataUrl
        : null;

  const save = async () => {
    setSaving(true);
    // A typed signature's image is drawn by the server, never sent.
    const body =
      values.signatureSource === "upload" ? values : { ...values, signatureImageDataUrl: undefined };
    const result = await sendJson("/api/settings/invoice", "PUT", body, NAMES);
    setSaving(false);
    setMessage(
      result.ok
        ? { text: "Saved. New invoices use these details.", error: false }
        : { text: result.message, error: true },
    );
    if (result.ok) router.refresh();
  };

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor="businessName">Business name</label>
      <input
        id="businessName"
        value={values.businessName ?? ""}
        placeholder={name}
        maxLength={120}
        onChange={(e) => {
          setValues((v) => ({ ...v, businessName: e.target.value }));
        }}
      />
      <div className="field-hint">
        Shown instead of your name ({name}) where a template uses it.
      </div>
      <label htmlFor="address">Address</label>
      <textarea
        id="address"
        rows={3}
        maxLength={500}
        value={values.address ?? ""}
        onChange={(e) => {
          setValues((v) => ({ ...v, address: e.target.value }));
        }}
      />
      <label htmlFor="logo">Logo</label>
      {values.logoDataUrl ? (
        // A data URL from this form or the database: nothing loads from the network.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={values.logoDataUrl} alt="Your logo" style={{ maxHeight: 48, maxWidth: 160 }} />
      ) : null}
      <input
        id="logo"
        type="file"
        accept={LOGO_TYPES.join(",")}
        onChange={(e) => {
          void pickLogo(e.target.files?.[0]);
        }}
      />
      {values.logoDataUrl ? (
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setValues((v) => ({ ...v, logoDataUrl: null }));
          }}
        >
          Remove logo
        </button>
      ) : null}
      <div className="field-hint">PNG, JPEG, GIF or WebP, under 200 KB.</div>
      <label htmlFor="invoicePaper">Paper size</label>
      <select
        id="invoicePaper"
        value={values.invoicePaper}
        onChange={(e) => {
          setValues((v) => ({ ...v, invoicePaper: e.target.value === "Letter" ? "Letter" : "A4" }));
        }}
      >
        <option value="A4">A4</option>
        <option value="Letter">US Letter</option>
      </select>
      <label className="inline">
        <input
          type="checkbox"
          checked={values.invoiceShowQr}
          onChange={(e) => {
            setValues((v) => ({ ...v, invoiceShowQr: e.target.checked }));
          }}
        />{" "}
        Show a QR code of the PayPal pay link
      </label>
      <fieldset>
        <legend>Signature</legend>
        {SOURCES.map(({ value, label }) => (
          <label key={label} className="inline">
            <input
              type="radio"
              name="signatureSource"
              checked={values.signatureSource === value}
              onChange={() => {
                setValues((v) => ({ ...v, signatureSource: value }));
              }}
            />{" "}
            {label}
          </label>
        ))}
        <p className="field-hint">{SIGNATURE_DISCLAIMER}</p>
        {values.signatureSource === "upload" ? (
          <div className="field">
            <label htmlFor="signatureImage">Signature image</label>
            <input
              id="signatureImage"
              type="file"
              accept={SIGNATURE_TYPES.join(",")}
              onChange={(e) => {
                void pickSignature(e.target.files?.[0]);
              }}
            />
            <div className="field-hint">PNG or JPG, under 500 KB. No SVG.</div>
          </div>
        ) : null}
        {values.signatureSource === "typed" ? (
          <div className="field">
            <label htmlFor="signatureTypedName">Name to draw</label>
            <input
              id="signatureTypedName"
              maxLength={120}
              value={values.signatureTypedName ?? ""}
              onChange={(e) => {
                setValues((v) => ({ ...v, signatureTypedName: e.target.value }));
              }}
            />
            <div className="field-hint">Drawn in a handwriting font when you save.</div>
          </div>
        ) : null}
        {signaturePreview ? (
          // A data URL from this form or the database: nothing loads from the network.
          // eslint-disable-next-line @next/next/no-img-element
          <img className="signature-preview" src={signaturePreview} alt="Your signature" />
        ) : null}
        {values.signatureSource ? (
          <>
            <div className="field">
              <label htmlFor="signatureName">Signer&apos;s name</label>
              <input
                id="signatureName"
                maxLength={120}
                value={values.signatureName ?? ""}
                onChange={(e) => {
                  setValues((v) => ({ ...v, signatureName: e.target.value }));
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="signatureTitle">Signer&apos;s title</label>
              <input
                id="signatureTitle"
                maxLength={120}
                value={values.signatureTitle ?? ""}
                onChange={(e) => {
                  setValues((v) => ({ ...v, signatureTitle: e.target.value }));
                }}
              />
            </div>
            <label className="inline">
              <input
                type="checkbox"
                checked={values.signatureDefault}
                onChange={(e) => {
                  setValues((v) => ({ ...v, signatureDefault: e.target.checked }));
                }}
              />{" "}
              Include my signature on new invoices
            </label>
          </>
        ) : null}
      </fieldset>
      <div className="actions">
        <button className="button" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save details"}
        </button>
      </div>
      {message ? (
        <div className={message.error ? "banner banner-error" : "banner"} role="status">
          {message.text}
        </div>
      ) : null}
    </form>
  );
};
