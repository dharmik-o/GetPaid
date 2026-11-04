import Link from "next/link";
import { GmailConnect } from "@/components/GmailConnect";
import { TelegramConnect } from "@/components/TelegramConnect";
import { gmailOAuthEnv, telegramBotUsername } from "@/lib/env";
import { getGmailAccount } from "@/lib/gmail-account";
import { runAsCurrentUser } from "@/lib/request-user";
import { getTelegramStatus } from "@/lib/telegram-link";

// Connections: Telegram and Gmail. PayPal uses the sandbox app from the local env file for now.

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ gmail?: string | string[] }> };

const IntegrationsPage = async ({ searchParams }: Props) => {
  const { gmail: outcome } = await searchParams;
  const { telegram, gmail } = await runAsCurrentUser(async (db) => ({
    telegram: await getTelegramStatus(db),
    gmail: await getGmailAccount(db),
  }));
  return (
    <div className="page">
      <div className="page-header">
        <h1>Integrations</h1>
      </div>
      <section className="card" aria-labelledby="integration-telegram">
        <h2 id="integration-telegram">Telegram</h2>
        <TelegramConnect
          connected={telegram.connected}
          configured={Boolean(telegramBotUsername())}
        />
      </section>
      <section className="card" aria-labelledby="integration-gmail">
        <h2 id="integration-gmail">Gmail</h2>
        <GmailConnect
          status={gmail.status}
          email={gmail.email}
          configured={Boolean(gmailOAuthEnv())}
          outcome={typeof outcome === "string" ? outcome : null}
        />
      </section>
      <section className="card" aria-labelledby="integration-paypal">
        <h2 id="integration-paypal">PayPal</h2>
        <p className="muted">Works through the sandbox app set up in your local env file.</p>
      </section>
      <Link href="/settings">Back to settings</Link>
    </div>
  );
};

export default IntegrationsPage;
