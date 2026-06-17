// frontend/src/problems/statementView.test.tsx
//
// W6: the shared statement renderer. Rendered with react-dom/server's
// renderToStaticMarkup (pure node — no jsdom), pinning three contracts:
//   1. plain/absent format keeps the EXACT pre-W6 <p> path (classes included)
//      and never interprets markdown syntax;
//   2. markdown format renders headings/emphasis/code/lists/GFM tables;
//   3. SAFETY: raw HTML inside a markdown statement comes out as escaped TEXT
//      — never as elements (react-markdown default, no rehype-raw).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatementView } from "./StatementView";

const render = (props: Parameters<typeof StatementView>[0]) =>
  renderToStaticMarkup(<StatementView {...props} />);

describe("StatementView — plain path (pre-W6 behavior, byte-for-byte)", () => {
  it("renders the exact legacy <p> when format is absent", () => {
    const html = render({ statement: "Read two integers.", className: "mt-2" });
    expect(html).toBe('<p class="mt-2 whitespace-pre-wrap text-sm text-muted">Read two integers.</p>');
  });

  it("renders the same <p> for an explicit plain format", () => {
    const html = render({ statement: "Read two integers.", format: "plain", className: "mt-2" });
    expect(html).toBe('<p class="mt-2 whitespace-pre-wrap text-sm text-muted">Read two integers.</p>');
  });

  it("does NOT interpret markdown syntax in plain mode", () => {
    const html = render({ statement: "# Not a heading with **not bold**" });
    expect(html).toContain("# Not a heading with **not bold**");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<strong");
  });

  it("escapes HTML in plain mode (React text node)", () => {
    const html = render({ statement: '<script>alert("x")</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("StatementView — markdown path", () => {
  it("renders headings, emphasis, inline code and lists", () => {
    const html = render({
      statement: "# Sum\n\nRead **two** integers and `a + b`.\n\n- first\n- second",
      format: "markdown"
    });
    expect(html).toContain("<h1>Sum</h1>");
    expect(html).toContain("<strong>two</strong>");
    expect(html).toContain("<code>a + b</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>first</li>");
  });

  it("renders fenced code blocks as <pre><code>", () => {
    const html = render({ statement: "```\nprint(a + b)\n```", format: "markdown" });
    expect(html).toContain("<pre>");
    expect(html).toContain("print(a + b)");
  });

  it("renders GFM tables and strikethrough (remark-gfm)", () => {
    const html = render({
      statement: "| a | b |\n|---|---|\n| 1 | 2 |\n\n~~old~~",
      format: "markdown"
    });
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<del>old</del>");
  });

  it("wraps the output in the scoped statement-markdown styling root", () => {
    const html = render({ statement: "hello", format: "markdown", className: "mt-2" });
    expect(html).toContain('class="statement-markdown mt-2 text-sm text-muted"');
  });

  it("SAFETY: raw HTML is escaped to text — no elements, no event handlers", () => {
    const html = render({
      statement: 'Before\n\n<script>alert("xss")</script>\n\n<img src=x onerror=alert(1)>\n\nAfter',
      format: "markdown"
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // The surrounding markdown still renders normally.
    expect(html).toContain("<p>Before</p>");
    expect(html).toContain("<p>After</p>");
  });

  it("SAFETY: javascript: link targets are neutralized by react-markdown's URL transform", () => {
    const html = render({ statement: "[click](javascript:alert(1))", format: "markdown" });
    expect(html).not.toContain("javascript:");
  });
});
