import { BRAND_NAME } from "@/lib/brand";

/** The yellow triangle and the wordmark. A drawn shape, because a clipped box can't have an outline. */
export const Logo = () => (
  <span className="logo">
    <svg className="logo-mark" viewBox="0 0 26 24" width="26" height="24" aria-hidden="true">
      <path d="M13 1.5 24.5 22.5H1.5Z" />
    </svg>
    <span className="logo-word">{BRAND_NAME}</span>
  </span>
);
