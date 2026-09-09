import { describe, expect, it } from "vitest";
import { renderAddPage, renderMarkdown, renderSettingsPage } from "../src/views.js";
import { APP_VERSION_LABEL } from "../src/version.js";

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
    expect(html).toContain('<a href="mailto:xfcosta@gmail.com">xfcosta@gmail.com</a>');
    expect(html).toContain(`Version:</strong> ${APP_VERSION_LABEL}`);
  });

  it("shows collapsible LLM computer-use guidance first in settings", () => {
    const html = renderSettingsPage();

    expect(html.indexOf('<details class="settings-group howto-group">')).toBeLessThan(html.indexOf("Accent color"));
    expect(html).toContain("<summary>HowTo</summary>");
    expect(html).toContain("Never invent metadata");
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
    expect(html).toContain('data-folder-zip-input');
    expect(html).toContain("Import");
    expect(html).toContain("From Folder");
    expect(html).toContain("From ZIP");
    expect(html.indexOf('data-upload-form')).toBeLessThan(html.indexOf("Import"));
    expect(html).toContain('id="single-pdf-input" name="file" type="file"');
    expect(html).toContain("Upload PDF");
    expect(html).toContain('<span>Find</span>');
    expect(html).toContain('data-bibtex-import');
    expect(html).not.toContain('Save paper');
  });
});
