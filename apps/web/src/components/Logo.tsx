import Link from "next/link";
import { BRAND_NAME } from "@/lib/brand";

/** The GetPaid stamp and the wordmark, as a link to the welcome page. The stamp's own lettering is too small to read at this size. */
export const Logo = ({ large = false }: { large?: boolean }) => (
  <Link
    href="/welcome"
    className={large ? "logo logo-large" : "logo"}
    aria-label={`${BRAND_NAME} home`}
  >
    <span className="logo-mark" aria-hidden="true" />
    <span className="logo-word">{BRAND_NAME}</span>
  </Link>
);
