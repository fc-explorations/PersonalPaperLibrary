import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/views.js";

describe("analysis Markdown rendering", () => {
  it("preserves LaTeX math from Markdown emphasis parsing", () => {
    const html = renderMarkdown("The density is \\(p_\\theta(x) = \\prod_i p_\\theta(x_i)\\) and $x_i$.");

    expect(html).toContain("\\(p_\\theta(x) = \\prod_i p_\\theta(x_i)\\)");
    expect(html).toContain("$x_i$");
    expect(html).not.toContain("<em>\\theta");
    expect(html).not.toContain("<em>i</em>");
  });

  it("still renders code spans without allowing math inside them", () => {
    const html = renderMarkdown("Use `p_\\theta(x)` in the implementation.");

    expect(html).toContain("<code>p_\\theta(x)</code>");
    expect(html).not.toContain("\\(p_\\theta(x)\\)");
  });
});
