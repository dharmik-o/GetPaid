import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TelegramConnect } from "@/components/TelegramConnect";
import { telegramBotUsername } from "@/lib/env";
import type { TelegramOp } from "@/lib/telegram-card";

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
    nodes: {
      name: string;
      parameters: {
        url?: string;
        rules?: { values: { conditions: { conditions: { rightValue: string }[] } }[] };
      };
    }[];
    connections: Record<string, { main: { node: string }[][] }>;
  };
  const next = (name: string) => workflow.connections[name]?.main[0]?.[0]?.node;
  const node = (name: string) => workflow.nodes.find((candidate) => candidate.name === name);

  it("sends both the bot's updates and the card run through the same steps", () => {
    expect(next("Telegram update")).toBe("Handle in the app");
    expect(node("Handle in the app")?.parameters.url).toMatch(/\/telegram\/update$/);
    expect(next("Every minute")).toBe("Cards to send");
    expect(node("Cards to send")?.parameters.url).toMatch(/\/telegram\/pending$/);
    expect(next("Handle in the app")).toBe("One step at a time");
    expect(next("Cards to send")).toBe("One step at a time");
  });

  it("has a Telegram node for every step the app can ask for", () => {
    const routed = node("Which step")?.parameters.rules?.values.map(
      (rule) => rule.conditions.conditions[0]?.rightValue,
    );
    expect(routed).toEqual([
      "sendCard",
      "sendText",
      "editText",
      "answer",
    ] satisfies TelegramOp["op"][]);
    expect(workflow.connections["Which step"]?.main).toHaveLength(routed?.length ?? 0);
  });

  it("reports a card back so it can be changed later", () => {
    expect(next("Send card")).toBe("Report the card");
    expect(node("Report the card")?.parameters.url).toMatch(/\/telegram\/delivered$/);
  });

  it("holds no token and starts inactive", () => {
    expect(raw).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{20,}/);
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(workflow.active).toBe(false);
  });
});
