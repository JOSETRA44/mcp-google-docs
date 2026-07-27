/**
 * Markdown → structured blocks.
 *
 * Google has no Markdown import at `batchUpdate` granularity — `files.export` reads Markdown out
 * but nothing writes a fragment of it back in. So an agent that wants to add a formatted section
 * has to either emit raw styling requests over indices it computed itself (the failure mode this
 * project exists to remove) or have the server compile Markdown for it.
 *
 * Parsing runs in two stages that mirror how Markdown actually works: block structure first
 * (which lines form a paragraph, a list item, a table), then inline spans within each block's
 * text. Inline parsing yields **plain text plus offset ranges**, never marked-up text, because
 * the Docs API applies styling to ranges of already-inserted plain text.
 */

export interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  link?: string;
}

/** A styled run within a block's plain text. Offsets are relative to the block. */
export interface InlineSpan {
  start: number;
  end: number;
  style: InlineStyle;
}

export type MdBlockKind = "paragraph" | "heading" | "listItem" | "table" | "rule" | "code";

export interface MdBlock {
  kind: MdBlockKind;
  /** Plain text, with every piece of Markdown syntax removed. */
  text: string;
  spans: InlineSpan[];
  /** Heading level 1-6. */
  level?: number;
  /** List nesting depth, 0-based. */
  depth?: number;
  ordered?: boolean;
  /** Whether the paragraph was a blockquote. */
  quote?: boolean;
  /** Table cells, row-major. Only for `kind === "table"`. */
  rows?: { text: string; spans: InlineSpan[] }[][];
}

/* -------------------------------------------------------------------------- */
/* Inline parsing                                                              */
/* -------------------------------------------------------------------------- */

interface InlineResult {
  text: string;
  spans: InlineSpan[];
}

/**
 * Parse inline markup into plain text plus style spans.
 *
 * Hand-written rather than regex-driven because the delimiters nest and overlap: `**bold with
 * *italic* inside**` needs two spans covering different extents of the same characters, which a
 * flat find-and-replace cannot express. A single left-to-right scan carrying a style stack
 * handles nesting naturally and, importantly, keeps offsets exact — every character appended to
 * the output knows which styles were open when it was written.
 */
export function parseInline(input: string): InlineResult {
  const out: string[] = [];
  const spans: InlineSpan[] = [];
  /** Styles currently open, each remembering where it started in the output. */
  const open: { marker: string; start: number; style: InlineStyle }[] = [];

  const push = (text: string) => out.push(text);
  const length = () => out.reduce((n, s) => n + s.length, 0);

  const closeMarker = (marker: string): boolean => {
    // Find the most recently opened matching marker; anything opened after it was never closed
    // and is treated as literal text, which is what Markdown readers do too.
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i]!.marker === marker) {
        const entry = open.splice(i, 1)[0]!;
        const end = length();
        if (end > entry.start) spans.push({ start: entry.start, end, style: entry.style });
        return true;
      }
    }
    return false;
  };

  let i = 0;
  while (i < input.length) {
    const rest = input.slice(i);

    // Escapes: a backslash makes the next character literal.
    if (rest.startsWith("\\") && i + 1 < input.length) {
      push(input[i + 1]!);
      i += 2;
      continue;
    }

    // Inline code binds tighter than everything else — its contents are literal by definition,
    // so it is consumed whole rather than scanned for other markers.
    if (rest.startsWith("`")) {
      const end = input.indexOf("`", i + 1);
      if (end !== -1) {
        const start = length();
        push(input.slice(i + 1, end));
        spans.push({ start, end: length(), style: { code: true } });
        i = end + 1;
        continue;
      }
    }

    // Links: [text](url)
    if (rest.startsWith("[")) {
      const close = input.indexOf("]", i);
      if (close !== -1 && input[close + 1] === "(") {
        const urlEnd = input.indexOf(")", close + 2);
        if (urlEnd !== -1) {
          const label = input.slice(i + 1, close);
          const url = input.slice(close + 2, urlEnd).trim();
          const start = length();
          // The label may itself be styled, so it is parsed recursively and its spans rebased.
          const inner = parseInline(label);
          push(inner.text);
          for (const span of inner.spans) {
            spans.push({ start: start + span.start, end: start + span.end, style: span.style });
          }
          spans.push({ start, end: length(), style: { link: url } });
          i = urlEnd + 1;
          continue;
        }
      }
    }

    if (rest.startsWith("~~")) {
      if (!closeMarker("~~")) open.push({ marker: "~~", start: length(), style: { strikethrough: true } });
      i += 2;
      continue;
    }

    if (rest.startsWith("**") || rest.startsWith("__")) {
      const marker = rest.slice(0, 2);
      if (!closeMarker(marker)) open.push({ marker, start: length(), style: { bold: true } });
      i += 2;
      continue;
    }

    if (rest.startsWith("*") || rest.startsWith("_")) {
      const marker = rest[0]!;
      if (!closeMarker(marker)) open.push({ marker, start: length(), style: { italic: true } });
      i += 1;
      continue;
    }

    push(input[i]!);
    i += 1;
  }

  return { text: out.join(""), spans };
}

/* -------------------------------------------------------------------------- */
/* Block parsing                                                               */
/* -------------------------------------------------------------------------- */

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_DIVIDER = /^\s*\|[\s:|-]+\|\s*$/;

/** Split a table row on unescaped pipes. */
function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (inner[i] === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += inner[i];
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Nesting depth from leading whitespace.
 *
 * Markdown writers indent with two spaces, four spaces or a tab interchangeably, and an agent
 * generating Markdown will not be consistent about it. Treating a tab as two spaces and rounding
 * down means all three conventions produce the depth the author visually intended.
 */
function indentDepth(indent: string): number {
  const columns = indent.replace(/\t/g, "  ").length;
  return Math.floor(columns / 2);
}

/** Parse a Markdown document into blocks. */
export function parseMarkdown(markdown: string): MdBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];

  /** Lines of the paragraph currently being accumulated. */
  let paragraph: string[] = [];
  let paragraphQuote = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    // Markdown joins wrapped lines of a paragraph with a space, not a line break.
    const inline = parseInline(paragraph.join(" ").trim());
    if (inline.text.length > 0) {
      blocks.push({
        kind: "paragraph",
        text: inline.text,
        spans: inline.spans,
        ...(paragraphQuote ? { quote: true } : {}),
      });
    }
    paragraph = [];
    paragraphQuote = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    // Fenced code blocks are consumed whole; their contents are literal.
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      blocks.push({ kind: "code", text: body.join("\n"), spans: [] });
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule", text: "", spans: [] });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const inline = parseInline(heading[2]!.trim());
      blocks.push({
        kind: "heading",
        text: inline.text,
        spans: inline.spans,
        level: heading[1]!.length,
      });
      continue;
    }

    // Tables: a row followed by a divider row. Without the divider it is just text with pipes.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
      flushParagraph();
      const rows: { text: string; spans: InlineSpan[] }[][] = [];
      rows.push(splitRow(line).map((cell) => parseInline(cell)));
      i += 2; // skip the divider
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) {
        rows.push(splitRow(lines[i]!).map((cell) => parseInline(cell)));
        i++;
      }
      i--; // the outer loop advances again
      blocks.push({ kind: "table", text: "", spans: [], rows });
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered) {
      flushParagraph();
      const inline = parseInline(ordered[3]!.trim());
      blocks.push({
        kind: "listItem",
        text: inline.text,
        spans: inline.spans,
        depth: indentDepth(ordered[1]!),
        ordered: true,
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      const inline = parseInline(bullet[3]!.trim());
      blocks.push({
        kind: "listItem",
        text: inline.text,
        spans: inline.spans,
        depth: indentDepth(bullet[1]!),
        ordered: false,
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      if (!paragraphQuote) flushParagraph();
      paragraphQuote = true;
      paragraph.push(quote[1]!);
      continue;
    }

    if (paragraphQuote) flushParagraph();
    paragraph.push(line.trim());
  }

  flushParagraph();
  return blocks;
}
