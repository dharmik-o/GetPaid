import { BRAND_NAME } from "@/lib/brand";

/** The GetPaid stamp and the wordmark. The stamp's own lettering is too small to read at this size. */
export const Logo = () => (
  <span className="logo">
    <span className="logo-mark" aria-hidden="true" />
    <span className="logo-word">{BRAND_NAME}</span>
  </span>
);
