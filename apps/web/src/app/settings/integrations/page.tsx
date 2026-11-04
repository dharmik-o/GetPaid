import Link from "next/link";
import { TelegramConnect } from "@/components/TelegramConnect";
import { telegramBotUsername } from "@/lib/env";
import { runAsCurrentUser } from "@/lib/request-user";
import { getTelegramStatus } from "@/lib/telegram-link";

// Connections. Telegram is here; Gmail comes in M7. PayPal uses the sandbox app from the local
// env file for now.

export const dynamic = "force-dynamic";

const IntegrationsPage = async () => {
  const { connected } = await runAsCurrentUser((db) => getTelegramStatus(db));
  return (
    <div className="page">
      <div className="page-header">
        <h1>Integrations</h1>
      </div>
      <section className="card" aria-labelledby="integration-telegram">
        <h2 id="integration-telegram">Telegram</h2>
        <TelegramConnect connected={connected} configured={Boolean(telegramBotUsername())} />
      </section>
      <section className="card" aria-labelledby="integration-gmail">
        <h2 id="integration-gmail">Gmail</h2>
        <p className="muted">Connecting Gmail for sending arrives in M7.</p>
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
