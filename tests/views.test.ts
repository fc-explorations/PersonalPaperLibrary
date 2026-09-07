import { describe, expect, it } from "vitest";
import { renderAddPage, renderMarkdown, renderSettingsPage } from "../src/views.js";
import { APP_VERSION } from "../src/version.js";

describe("theme settings rendering", () => {
  it("shows the derived background colors preview", () => {
    const html = renderSettingsPage();

    expect(html).toContain("Derived section colors");
    expect(html).toContain('data-derived-color-swatch="sectionColor"');
    expect(html).toContain('data-derived-color-swatch="sectionSurface"');
    expect(html).toContain('data-derived-color-swatch="sectionBorder"');
  });

  it("shows credits and the current application version", () => {
    const html = renderSettingsPage();

    expect(html).toContain("Credits");
    expect(html).toContain("Ideation:");
    expect(html).toContain("Fabrizio Costa");
    expect(html).toContain(`Version:</strong> ${APP_VERSION}`);
  });
});

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

describe("add page rendering", () => {
  it("shows the folder-tag switch enabled by default", () => {
    const html = renderAddPage();

    expect(html).toContain('data-folder-tag-toggle checked');
    expect(html).toContain('data-folder-tag-value>True</span>');
    expect(html).toContain("Use folder as tag");
  });
});
