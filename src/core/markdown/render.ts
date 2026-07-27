import type { Block, ParsedDocument, TableInfo } from "../ast/types.js";
import { OBJECT_PLACEHOLDER } from "../ast/walk.js";

/**
 * Render a parsed document as Markdown for an agent to read.
 *
 * Two modes, because reading and editing want different things:
 *
 *   - **clean** — prose only. What you want when summarizing or answering a question about the
 *     document. Costs the fewest tokens.
 *   - **addressed** — every block prefixed with `{#id}`. What you want before editing, because
 *     those ids are the handles the write tools take. They cost roughly eight characters per
 *     block, which is the price of never handing an agent an integer index.
 */

export type RenderMode = "clean" | "addressed";

export interface RenderOptions {
  mode?: RenderMode;
  /** Include headers, footers and footnotes. Off by default: they are rarely what was asked for. */
  includeSegments?: boolean;
  /** Restrict output to one tab. */
  tabId?: string;
}

/** Anything that occupies a position in the linear reading order. */
type Renderable =
  | { type: "block"; block: Block; tabOrdinal: number; segmentId: string; start: number }
  | { type: "table"; table: TableInfo; tabOrdinal: number; segmentId: string; start: number };

function escapePipes(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/**
 * Substitute inline images back into a block's text.
 *
 * Placeholders are replaced from the end backwards so that each substitution cannot shift the
 * offsets of the ones not yet processed.
 */
function withImages(block: Block, document: ParsedDocument): string {
  let text = block.text;

  const refs = [...(block.inlineObjectRefs ?? [])].sort((a, b) => b.offset - a.offset);
  for (const ref of refs) {
    const object = document.inlineObjects[ref.objectId];
    const alt = object?.altTitle ?? object?.altDescription ?? "image";
    const markdown = `![${alt}](inline-object:${ref.objectId})`;
    text = text.slice(0, ref.offset) + markdown + text.slice(ref.offset + 1);
  }

  // Placeholders with no image behind them are breaks, footnote references and the like. They
  // are structural, not textual, so they are dropped rather than shown as replacement glyphs.
  return text.split(OBJECT_PLACEHOLDER).join("");
}

function renderBlock(block: Block, document: ParsedDocument, mode: RenderMode): string | null {
  const marker = mode === "addressed" ? `{#${block.id}} ` : "";
  const text = withImages(block, document);

  switch (block.kind) {
    case "heading": {
      const hashes = "#".repeat(Math.min(6, Math.max(1, block.level ?? 1)));
      return `${hashes} ${marker}${text}`;
    }
    case "listItem": {
      const indent = "  ".repeat(block.listDepth ?? 0);
      const bullet = block.ordered ? "1." : "-";
      return `${indent}${bullet} ${marker}${text}`;
    }
    case "sectionBreak":
      // A section break at the very top of a document is an artifact of Docs' model, not
      // something a reader ever sees, so it is not rendered as a rule.
      return null;
    case "tableOfContents":
      return `${marker}_[table of contents]_`;
    case "paragraph":
    case "tableCell":
    default:
      if (text.trim().length === 0) return null;
      return `${marker}${text}`;
  }
}

function renderTable(table: TableInfo, document: ParsedDocument, mode: RenderMode): string {
  const byId = new Map(document.blocks.map((b) => [b.id, b]));

  const rows = table.cells.map((row) =>
    row.map((cell) =>
      cell.blocks
        .map((id) => {
          const block = byId.get(id);
          return block ? escapePipes(withImages(block, document)) : "";
        })
        .filter((t) => t.length > 0)
        // A cell can hold several paragraphs; Markdown tables cannot, so they are joined with a
        // line break that renderers understand inside a cell.
        .join("<br>"),
    ),
  );

  if (rows.length === 0) return "";

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (row: string[]) => {
    const padded = [...row];
    while (padded.length < width) padded.push("");
    return padded;
  };

  const [header, ...body] = rows;
  const lines = [
    `| ${pad(header!).join(" | ")} |`,
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map((row) => `| ${pad(row).join(" | ")} |`),
  ];

  const label = mode === "addressed" ? `{#${table.id}}\n` : "";
  return `${label}${lines.join("\n")}`;
}

export function renderMarkdown(document: ParsedDocument, options: RenderOptions = {}): string {
  const { mode = "clean", includeSegments = false, tabId } = options;

  const tabOrdinalOf = new Map(document.tabs.map((t) => [t.tabId, t.ordinal]));
  const cellBlockIds = new Set(
    document.tables.flatMap((t) => t.cells.flatMap((row) => row.flatMap((cell) => cell.blocks))),
  );

  const items: Renderable[] = [];

  for (const block of document.blocks) {
    // Cells are rendered as part of their table, not as free-standing blocks.
    if (cellBlockIds.has(block.id)) continue;
    if (tabId && block.range.tabId !== tabId) continue;
    if (!includeSegments && block.range.segmentId !== "") continue;
    items.push({
      type: "block",
      block,
      tabOrdinal: tabOrdinalOf.get(block.range.tabId) ?? 0,
      segmentId: block.range.segmentId,
      start: block.range.startIndex,
    });
  }

  for (const table of document.tables) {
    if (tabId && table.range.tabId !== tabId) continue;
    if (!includeSegments && table.range.segmentId !== "") continue;
    items.push({
      type: "table",
      table,
      tabOrdinal: tabOrdinalOf.get(table.range.tabId) ?? 0,
      segmentId: table.range.segmentId,
      start: table.range.startIndex,
    });
  }

  // Reading order is tab, then segment, then position. Sorting by index alone would interleave
  // the body with headers, whose indices are a separate space starting again at zero.
  items.sort(
    (a, b) =>
      a.tabOrdinal - b.tabOrdinal ||
      a.segmentId.localeCompare(b.segmentId) ||
      a.start - b.start,
  );

  const out: string[] = [];
  let lastTabOrdinal: number | undefined;
  let lastSegmentId: string | undefined;

  for (const item of items) {
    if (document.tabs.length > 1 && item.tabOrdinal !== lastTabOrdinal) {
      const tab = document.tabs.find((t) => t.ordinal === item.tabOrdinal);
      if (tab) out.push(`\n<!-- tab: ${tab.title} (${tab.tabId}) -->`);
      lastTabOrdinal = item.tabOrdinal;
      lastSegmentId = undefined;
    }
    if (includeSegments && item.segmentId !== lastSegmentId && item.segmentId !== "") {
      out.push(`\n<!-- segment: ${item.segmentId} -->`);
      lastSegmentId = item.segmentId;
    }

    const rendered =
      item.type === "block"
        ? renderBlock(item.block, document, mode)
        : renderTable(item.table, document, mode);

    if (rendered !== null && rendered.length > 0) out.push(rendered);
  }

  return out.join("\n\n").trim();
}

/** A compact heading-only view, for orienting in a long document without reading it. */
export function renderOutline(document: ParsedDocument): string {
  const headings = document.blocks.filter((b) => b.kind === "heading");
  if (headings.length === 0) return "This document has no headings.";

  return headings
    .map((h) => {
      const indent = "  ".repeat(Math.max(0, (h.level ?? 1) - 1));
      return `${indent}- {#${h.id}} ${h.text}`;
    })
    .join("\n");
}
