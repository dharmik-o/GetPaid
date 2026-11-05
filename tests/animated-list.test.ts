import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnimatedList } from "@/components/AnimatedList";

// What's on the page when it loads must be fully visible, even if JavaScript never runs.

const html = renderToStaticMarkup(
  createElement(AnimatedList, {
    children: [
      createElement("p", { key: "a" }, "First"),
      createElement("p", { key: "b" }, "Second"),
    ],
  }),
);

describe("an animated list on the server", () => {
  it("renders every item", () => {
    expect(html).toContain("First");
    expect(html).toContain("Second");
    expect(html.match(/class="list-item"/g)).toHaveLength(2);
  });

  it("starts open, not collapsed or faded", () => {
    expect(html).not.toContain("height:0");
    expect(html).not.toContain("opacity:0");
  });
});
