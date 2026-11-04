import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TelegramConnect } from "@/components/TelegramConnect";
import { telegramBotUsername } from "@/lib/env";

// next is installed in the web workspace only, so the mock names its path from here.
vi.mock("../apps/web/node_modules/next/navigation.js", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

const render = (connected: boolean, configured: boolean) =>
  renderToStaticMarkup(createElement(TelegramConnect, { connected, configured }));

describe("TelegramConnect", () => {
  it("offers Connect, and says the chats aren't end-to-end encrypted", () => {
    const html = render(false, true);
    expect(html).toContain("Connect Telegram");
    expect(html).toContain("end-to-end encrypted");
  });

  it("offers Disconnect once connected", () => {
    const html = render(true, true);
    expect(html).toContain("Disconnect Telegram");
    expect(html).not.toContain(">Connect Telegram<");
  });

  it("says what to set when the bot isn't configured, and that the Outbox still works", () => {
    const html = render(false, false);
    expect(html).toContain("TELEGRAM_BOT_USERNAME");
    expect(html).toContain("Outbox");
    expect(html).not.toContain("<button");
  });
});

describe("telegramBotUsername", () => {
  it("accepts a username, with or without the @", () => {
    expect(telegramBotUsername({ TELEGRAM_BOT_USERNAME: "RecoveryBot" })).toBe("RecoveryBot");
    expect(telegramBotUsername({ TELEGRAM_BOT_USERNAME: "@RecoveryBot" })).toBe("RecoveryBot");
  });

  it("gives nothing when unset, or when it could change the link", () => {
    expect(telegramBotUsername({})).toBeUndefined();
    expect(telegramBotUsername({ TELEGRAM_BOT_USERNAME: "evil.example/x" })).toBeUndefined();
  });
});

describe("03_approval_handler workflow", () => {
  const raw = readFileSync(
    join(import.meta.dirname, "..", "n8n", "workflows", "03_approval_handler.json"),
    "utf8",
  );
  const workflow = JSON.parse(raw) as {
    active: boolean;
    nodes: { name: string; type: string; parameters: { url?: string } }[];
    connections: Record<string, { main: { node: string }[][] }>;
  };

  it("relays each update to the app, then sends the app's reply", () => {
    const relay = workflow.nodes.find((node) => node.name === "Handle in the app");
    expect(relay?.parameters.url).toMatch(/\/api\/internal\/telegram\/update$/);
    expect(workflow.connections["Telegram update"]?.main[0]?.[0]?.node).toBe("Handle in the app");
    expect(workflow.connections["Has a reply?"]?.main[0]?.[0]?.node).toBe("Send the reply");
  });

  it("holds no token and starts inactive", () => {
    expect(raw).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{20,}/);
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(workflow.active).toBe(false);
  });
});
