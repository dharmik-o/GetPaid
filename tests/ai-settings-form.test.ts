import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiSettingsForm, type SavedAiSettings } from "@/components/AiSettingsForm";
import { AI_PRESETS } from "@/lib/ai-presets";

// The AI settings form, rendered on the server as the page does.

// next is installed in the web workspace only, so the mock names its path from here.
vi.mock("../apps/web/node_modules/next/navigation.js", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

const render = (initial: SavedAiSettings) =>
  renderToStaticMarkup(createElement(AiSettingsForm, { initial }));

const EMPTY: SavedAiSettings = {
  main: null,
  cloudFallback: null,
  taskModels: { sort: null, tier3: null },
};

describe("AiSettingsForm", () => {
  it("offers every preset from the spec, starting with a local model", () => {
    const html = render(EMPTY);
    for (const preset of AI_PRESETS) expect(html).toContain(preset.label);
    expect(html).toContain('value="http://127.0.0.1:11434/v1"');
    // A local main model can have a cloud fallback.
    expect(html).toContain("Use a cloud model as a fallback");
  });

  it("says a key is saved without ever putting it in the page", () => {
    const html = render({
      ...EMPTY,
      main: {
        provider: "claude",
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-sonnet-5-5",
        isLocal: false,
        hasKey: true,
      },
    });
    expect(html).toContain("Saved and hidden. Leave blank to keep it.");
    expect(html).toContain("Remove the saved key");
    expect(html).toMatch(/type="password"[^>]*value=""/);
    // A cloud main model falls back to the template, not another cloud model.
    expect(html).not.toContain("Use a cloud model as a fallback");
    expect(html).toContain("falls back to a fixed template");
  });
});
