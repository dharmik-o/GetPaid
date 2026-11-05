import type { Metadata } from "next";
import { LandingFeatures } from "@/components/landing/LandingFeatures";
import { LandingFooter, LandingNav } from "@/components/landing/LandingFrame";
import { LandingHero } from "@/components/landing/LandingHero";
import { LandingHow } from "@/components/landing/LandingHow";
import { LandingBand, LandingFinal } from "@/components/landing/LandingClose";
import { LandingMotion } from "@/components/landing/LandingMotion";
import { BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `${BRAND_NAME}: you did the work, now get paid for it`,
  description:
    "AI drafts your payment reminders, you approve them from Telegram, and every email carries a PayPal pay link.",
};

/** Words come from docs/design/landing-copy.md, and every call to action goes to the dashboard. */
const WelcomePage = () => (
  <LandingMotion>
    <LandingNav />
    <main>
      <LandingHero />
      <LandingHow />
      <LandingFeatures />
      <LandingBand />
      <LandingFinal />
    </main>
    <LandingFooter />
  </LandingMotion>
);

export default WelcomePage;
