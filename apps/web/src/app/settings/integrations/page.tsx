import Link from "next/link";
import { ComingSoon } from "@/components/ComingSoon";

// Connect PayPal, Gmail and Telegram. Telegram comes in M6, Gmail in M7; PayPal uses the
// sandbox app from the local env file for now.

const IntegrationsPage = () => (
  <ComingSoon
    title="Integrations"
    what="Connect Telegram for approvals and Gmail for sending. PayPal already works through the sandbox app set up in your local env file."
    milestone="M6 (Telegram) and M7 (Gmail)"
  >
    <Link className="button" href="/settings">
      Back to settings
    </Link>
  </ComingSoon>
);

export default IntegrationsPage;
