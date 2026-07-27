import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../src/core/markdown/parse.js";
import { compileMarkdown } from "../src/core/markdown/compile.js";
import { orderRequests } from "../src/core/mutate/plan.js";

const POSITION = { startIndex: 100, endIndex: 100, segmentId: "", tabId: "tab-1" };

describe("inline parsing", () => {
  it("strips markup and reports offsets into the plain text", () => {
    const { text, spans } = parseInline("say **hello** now");
    expect(text).toBe("say hello now");
    expect(spans).toHaveLength(1);
    // "hello" sits at offsets 4..9 of the plain text, not of the marked-up input.
    expect(spans[0]).toMatchObject({ start: 4, end: 9, style: { bold: true } });
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("hello");
  });

  it("handles nested emphasis as overlapping spans", () => {
    const { text, spans } = parseInline("**bold with *italic* inside**");
    expect(text).toBe("bold with italic inside");

    const bold = spans.find((s) => s.style.bold)!;
    const italic = spans.find((s) => s.style.italic)!;
    expect(text.slice(bold.start, bold.end)).toBe("bold with italic inside");
    expect(text.slice(italic.start, italic.end)).toBe("italic");
  });

  it("parses links and keeps the label styled", () => {
    const { text, spans } = parseInline("see [the **docs**](https://example.com) here");
    expect(text).toBe("see the docs here");

    const link = spans.find((s) => s.style.link)!;
    expect(link.style.link).toBe("https://example.com");
    expect(text.slice(link.start, link.end)).toBe("the docs");

    const bold = spans.find((s) => s.style.bold)!;
    expect(text.slice(bold.start, bold.end)).toBe("docs");
  });

  it("treats inline code as literal", () => {
    const { text, spans } = parseInline("run `a **b** c` now");
    expect(text).toBe("run a **b** c now");
    const code = spans.find((s) => s.style.code)!;
    expect(text.slice(code.start, code.end)).toBe("a **b** c");
    // The asterisks inside the code span must not have produced a bold span.
    expect(spans.filter((s) => s.style.bold)).toHaveLength(0);
  });

  it("honours backslash escapes", () => {
    const { text, spans } = parseInline("literal \\*not italic\\* here");
    expect(text).toBe("literal *not italic* here");
    expect(spans).toHaveLength(0);
  });

  it("leaves an unclosed marker as literal text", () => {
    const { text } = parseInline("a ** dangling");
    expect(text).toBe("a  dangling");
  });
});

describe("block parsing", () => {
  it("parses headings with their level", () => {
    const blocks = parseMarkdown("# One\n\n### Three");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 1, text: "One" });
    expect(blocks[1]).toMatchObject({ kind: "heading", level: 3, text: "Three" });
  });

  it("joins wrapped paragraph lines with a space", () => {
    const blocks = parseMarkdown("first line\nsecond line\n\nnew paragraph");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe("first line second line");
    expect(blocks[1]!.text).toBe("new paragraph");
  });

  it("reads list nesting from indentation, however it was written", () => {
    const blocks = parseMarkdown("- top\n  - two spaces\n\ttab indented\n    - four spaces");
    const items = blocks.filter((b) => b.kind === "listItem");
    expect(items.map((b) => b.depth)).toEqual([0, 1, 2]);
  });

  it("distinguishes ordered from bulleted lists", () => {
    const blocks = parseMarkdown("1. first\n2. second\n\n- bullet");
    const items = blocks.filter((b) => b.kind === "listItem");
    expect(items.map((b) => b.ordered)).toEqual([true, true, false]);
  });

  it("requires a divider row before treating pipes as a table", () => {
    const table = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(table[0]!.kind).toBe("table");
    expect(table[0]!.rows).toHaveLength(2);
    expect(table[0]!.rows![0]!.map((c) => c.text)).toEqual(["a", "b"]);

    const notTable = parseMarkdown("| just | pipes |");
    expect(notTable[0]!.kind).toBe("paragraph");
  });

  it("keeps fenced code literal", () => {
    const blocks = parseMarkdown("```js\nconst a = **1**;\n```");
    expect(blocks[0]).toMatchObject({ kind: "code", text: "const a = **1**;" });
  });

  it("recognises horizontal rules and blockquotes", () => {
    const blocks = parseMarkdown("---\n\n> quoted text");
    expect(blocks[0]!.kind).toBe("rule");
    expect(blocks[1]).toMatchObject({ kind: "paragraph", quote: true, text: "quoted text" });
  });
});

describe("compilation to requests", () => {
  it("inserts all text in a single request", () => {
    const { requests, text } = compileMarkdown(parseMarkdown("# Title\n\nBody text"), POSITION);
    const inserts = requests.filter((r) => r.request.insertText);
    expect(inserts).toHaveLength(1);
    expect(text).toBe("Title\nBody text\n");
    expect(inserts[0]!.request.insertText!.location).toMatchObject({ index: 100, tabId: "tab-1" });
  });

  it("places style ranges at absolute indices matching the inserted text", () => {
    const { requests, text } = compileMarkdown(parseMarkdown("a **bold** word"), POSITION);
    expect(text).toBe("a bold word\n");

    const style = requests.find((r) => r.request.updateTextStyle)!;
    const range = style.request.updateTextStyle!.range!;
    // "bold" is at offsets 2..6 of the inserted text, which begins at index 100.
    expect(range.startIndex).toBe(102);
    expect(range.endIndex).toBe(106);
    expect(text.slice(range.startIndex! - 100, range.endIndex! - 100)).toBe("bold");
  });

  it("orders the insert before the styles that depend on it", () => {
    const { requests } = compileMarkdown(parseMarkdown("# Heading\n\nsome **bold** text"), POSITION);
    const ordered = orderRequests(requests);

    // Styles reference text that does not exist until the insert has run, so the insert must be
    // first regardless of the fact that it sits at the lowest index.
    expect(ordered[0]!.insertText).toBeDefined();
    expect(ordered.slice(1).every((r) => !r.insertText)).toBe(true);
  });

  it("runs bullet creation after every style request", () => {
    const { requests } = compileMarkdown(parseMarkdown("- **one**\n- two"), POSITION);
    const ordered = orderRequests(requests);

    const bulletIndex = ordered.findIndex((r) => r.createParagraphBullets);
    const lastStyleIndex = ordered.reduce(
      (last, r, i) => (r.updateTextStyle || r.updateParagraphStyle ? i : last),
      -1,
    );
    // Bullets strip the tabs that encode nesting, shifting indices; styles must already be on.
    expect(bulletIndex).toBeGreaterThan(lastStyleIndex);
  });

  it("encodes list nesting as tabs and groups a run into one request", () => {
    const { requests, text } = compileMarkdown(parseMarkdown("- a\n  - b\n- c"), POSITION);
    expect(text).toBe("a\n\tb\nc\n");

    const bullets = requests.filter((r) => r.request.createParagraphBullets);
    expect(bullets).toHaveLength(1);
    expect(bullets[0]!.request.createParagraphBullets!.range).toMatchObject({
      startIndex: 100,
      endIndex: 106,
    });
  });

  it("splits bullet runs when the list type changes", () => {
    const { requests } = compileMarkdown(parseMarkdown("- a\n\n1. b"), POSITION);
    const bullets = requests.filter((r) => r.request.createParagraphBullets);
    expect(bullets).toHaveLength(2);
    const presets = bullets.map((b) => b.request.createParagraphBullets!.bulletPreset);
    expect(presets).toContain("BULLET_DISC_CIRCLE_SQUARE");
    expect(presets).toContain("NUMBERED_DECIMAL_ALPHA_ROMAN");
  });

  it("applies the heading's named style over its own range only", () => {
    const { requests } = compileMarkdown(parseMarkdown("# H\n\nbody"), POSITION);
    const paragraphStyle = requests.find((r) => r.request.updateParagraphStyle)!;
    const range = paragraphStyle.request.updateParagraphStyle!.range!;
    expect(paragraphStyle.request.updateParagraphStyle!.paragraphStyle!.namedStyleType).toBe("HEADING_1");
    expect(range.startIndex).toBe(100);
    // "H" is one character, so the range must not reach into the body paragraph.
    expect(range.endIndex).toBe(101);
  });

  it("surfaces tables as pending rather than dropping them", () => {
    const { pendingTables, text } = compileMarkdown(
      parseMarkdown("intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter"),
      POSITION,
    );
    expect(pendingTables).toHaveLength(1);
    expect(pendingTables[0]!.rows).toHaveLength(2);
    expect(text).toBe("intro\nafter\n");
  });

  it("produces nothing for empty markdown", () => {
    const { requests, text } = compileMarkdown(parseMarkdown("   \n\n  "), POSITION);
    expect(requests).toHaveLength(0);
    expect(text).toBe("");
  });
});
