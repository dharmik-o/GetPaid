import type { AgreementOptions } from "./agreement-template";
import { formatAmountInput, parseAmount } from "./currencies";
import { formatPercent, parsePercent } from "./schedule-form";

// The agreement builder's form: its text values, and the request options built from them. Pure.

export type BuilderValues = {
  depositPercent: string;
  ipTransfer: string;
  revisionRounds: string;
  acceptanceDays: string;
  killFeePercent: string;
  paymentDays: string;
  lateMode: "statutory" | "contract_rate";
  ratePercent: string;
  fixedFee: string;
  governingLawCountry: string;
  confidentiality: boolean;
  portfolioUse: boolean;
};

export const LABELS: Record<string, string> = {
  depositPercent: "Deposit",
  ipTransfer: "Ownership",
  revisionRounds: "Revision rounds",
  acceptanceDays: "Days to accept",
  killFeePercent: "Cancellation fee",
  paymentDays: "Days to pay",
  lateFee: "Late payment",
  "lateFee.rateBpPerMonth": "Monthly rate",
  "lateFee.fixedFeeCents": "Fixed late fee",
  governingLawCountry: "Governing law",
};

/** The builder's values for a saved agreement's options (or the defaults for a first draft). */
export const valuesFromOptions = (
  options: AgreementOptions | null,
  currency: string,
  governingLawCountry: string,
): BuilderValues => {
  const lateFee = options?.lateFee ?? { mode: "statutory" as const };
  const rate = lateFee.mode === "contract_rate" ? lateFee.rateBpPerMonth : 0;
  const fee = lateFee.mode === "contract_rate" ? lateFee.fixedFeeCents : 0;
  return {
    depositPercent: String(options?.depositPercent ?? 30),
    ipTransfer: options?.ipTransfer ?? "on_full_payment",
    revisionRounds: String(options?.revisionRounds ?? 2),
    acceptanceDays: String(options?.acceptanceDays ?? 5),
    killFeePercent: String(options?.killFeePercent ?? 25),
    paymentDays: String(options?.paymentDays ?? 15),
    lateMode: lateFee.mode,
    ratePercent: formatPercent(rate),
    fixedFee: fee > 0 ? formatAmountInput(fee, currency) : "",
    governingLawCountry: options?.governingLawCountry ?? governingLawCountry,
    confidentiality: options?.confidentiality ?? true,
    portfolioUse: options?.portfolioUse ?? true,
  };
};

type Built = { ok: true; options: Record<string, unknown> } | { ok: false; message: string };

const wholeNumber = (label: string, text: string): number | string => {
  const value = Number(text);
  return text.trim() !== "" && Number.isInteger(value) ? value : `${label} must be a whole number.`;
};

/** The request's options from the form's text, or the first thing wrong with it. */
export const buildOptions = (values: BuilderValues, currency: string): Built => {
  const numbers = {
    depositPercent: wholeNumber(LABELS.depositPercent ?? "", values.depositPercent),
    revisionRounds: wholeNumber(LABELS.revisionRounds ?? "", values.revisionRounds),
    acceptanceDays: wholeNumber(LABELS.acceptanceDays ?? "", values.acceptanceDays),
    killFeePercent: wholeNumber(LABELS.killFeePercent ?? "", values.killFeePercent),
    paymentDays: wholeNumber(LABELS.paymentDays ?? "", values.paymentDays),
  };
  const bad = Object.values(numbers).find((value) => typeof value === "string");
  if (typeof bad === "string") return { ok: false, message: bad };
  let lateFee: Record<string, unknown> = { mode: "statutory" };
  if (values.lateMode === "contract_rate") {
    const rate = values.ratePercent.trim() === "" ? 0 : parsePercent(values.ratePercent);
    if (Number.isNaN(rate)) return { ok: false, message: "Monthly rate must be like 1.5." };
    const fee =
      values.fixedFee.trim() === ""
        ? { ok: true as const, minor: 0 }
        : parseAmount(values.fixedFee, currency);
    if (!fee.ok) return { ok: false, message: `Fixed late fee ${fee.message}.` };
    lateFee = { mode: "contract_rate", rateBpPerMonth: rate, fixedFeeCents: fee.minor };
  }
  return {
    ok: true,
    options: {
      ...numbers,
      ipTransfer: values.ipTransfer,
      lateFee,
      governingLawCountry: values.governingLawCountry,
      confidentiality: values.confidentiality,
      portfolioUse: values.portfolioUse,
    },
  };
};
