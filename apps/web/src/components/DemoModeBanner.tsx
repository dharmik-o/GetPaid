import { isDemoMode } from "@/lib/demo-gate";

// Shown on every app page of the public demo, so nobody mistakes it for a real account.

export const DemoModeBanner = ({ demo = isDemoMode() }: { demo?: boolean }) =>
  demo ? (
    <p className="banner" role="note">
      Demo: sandbox payments, emails only go to the demo inbox.
    </p>
  ) : null;
