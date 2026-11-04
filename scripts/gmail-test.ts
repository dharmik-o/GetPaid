import { devEmailAllowlist } from "../apps/web/src/lib/env";
import { firstAllowlisted, maskAddress, setUpLiveTest, type ApiCall } from "./lib/gmail-test-setup";

// `npm run gmail:test`: a client on the first DEV_EMAIL_ALLOWLIST address and a small sandbox
// invoice with a real pay link, for checking a real send. Needs the dev server. It only reads the
// allowlist, and it never prints the whole address.

const APP_URL = "http://localhost:3000";

const api: ApiCall = async (method, path, body) => {
  const response = await fetch(`${APP_URL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      `${method} ${path} failed (${String(response.status)}): ${JSON.stringify(answer)}`,
    );
  }
  return answer;
};

const main = async (): Promise<void> => {
  const email = firstAllowlisted(devEmailAllowlist());
  const today = new Date().toISOString().slice(0, 10);
  const invoice = await setUpLiveTest(api, email, today);
  const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  say(`Client created on ${maskAddress(email)}.`);
  say(
    `Invoice ${invoice.invoiceNumber}: ${String(invoice.amountCents)} ${invoice.currency} cents.`,
  );
  say(`Pay link: ${invoice.link}`);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
