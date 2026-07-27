import type { docs_v1 } from "googleapis";
import type { DocRange, ParsedDocument, TableInfo } from "../ast/types.js";
import type { Address } from "../address/resolve.js";
import { resolveAddress } from "../address/resolve.js";
import { mutate, type MutationOptions } from "../mutate/executor.js";
import { at, toApiRange, type PlannedRequest } from "../mutate/plan.js";
import { compileMarkdown, type PendingTable } from "./compile.js";
import { parseMarkdown } from "./parse.js";

/**
 * Writing a Markdown fragment into a document.
 *
 * Most of it is one cycle: parse, compile, insert. Tables force more, because a table's cells do
 * not exist — and so have no indices — until the table itself has been created. Each table
 * therefore needs its own create-then-fill pair, and every one of those cycles re-reads the
 * document, so a collaborator editing midway through is transformed against rather than
 * clobbered.
 */

export interface WriteMarkdownResult {
  /** Characters of prose inserted in the first cycle. */
  insertedCharacters: number;
  tablesCreated: number;
  /** Revision before the very first cycle — the point to restore to. */
  fromRevisionId: string;
  toRevisionId: string | undefined;
  /** Total batchUpdate calls made, including retries after a collaborator's edit. */
  cycles: number;
}

/**
 * Fill a freshly created table's cells.
 *
 * Two ordering constraints collide here, and neither can be dropped:
 *
 *   - **Across cells**, work must run from the highest index down, so that filling one cell never
 *     shifts a cell not yet filled.
 *   - **Within a cell**, the text must be inserted before it can be styled.
 *
 * Descending index alone violates the second; a global insert-then-style phase split violates the
 * first, because a style range computed before any filling is stale once an earlier cell grows.
 * Giving each cell its own pair of consecutive phases, assigned in descending index order,
 * satisfies both at once.
 */
function fillTableRequests(table: TableInfo, pending: PendingTable, document: ParsedDocument): PlannedRequest[] {
  const byId = new Map(document.blocks.map((b) => [b.id, b]));
  const requests: PlannedRequest[] = [];

  interface CellWork {
    index: number;
    range: DocRange;
    text: string;
    spans: { start: number; end: number; style: docs_v1.Schema$TextStyle; fields: string[] }[];
  }
  const work: CellWork[] = [];

  for (let row = 0; row < table.cells.length; row++) {
    const sourceRow = pending.rows[row];
    if (!sourceRow) continue;

    for (let column = 0; column < table.cells[row]!.length; column++) {
      const source = sourceRow[column];
      if (!source || source.text.length === 0) continue;

      const cell = table.cells[row]![column]!;
      const firstBlockId = cell.blocks[0];
      const block = firstBlockId ? byId.get(firstBlockId) : undefined;
      if (!block) continue;

      work.push({
        index: block.textRange.startIndex,
        range: block.textRange,
        text: source.text,
        spans: source.spans
          .map((span) => {
            const style: docs_v1.Schema$TextStyle = {};
            const fields: string[] = [];
            if (span.style.bold) {
              style.bold = true;
              fields.push("bold");
            }
            if (span.style.italic) {
              style.italic = true;
              fields.push("italic");
            }
            if (span.style.strikethrough) {
              style.strikethrough = true;
              fields.push("strikethrough");
            }
            if (span.style.link) {
              style.link = { url: span.style.link };
              fields.push("link");
            }
            return { start: span.start, end: span.end, style, fields };
          })
          .filter((s) => s.fields.length > 0),
      });
    }
  }

  // Highest index first, so each cell's phases are assigned in the order they must execute.
  work.sort((a, b) => b.index - a.index);

  work.forEach((cell, ordinal) => {
    const insertPhase = ordinal * 2;
    const stylePhase = insertPhase + 1;

    requests.push(
      at(
        cell.index,
        {
          insertText: {
            location: {
              index: cell.index,
              segmentId: cell.range.segmentId,
              tabId: cell.range.tabId,
            },
            text: cell.text,
          },
        },
        insertPhase,
      ),
    );

    for (const span of cell.spans) {
      requests.push(
        at(
          cell.index + span.start,
          {
            updateTextStyle: {
              range: toApiRange({
                startIndex: cell.index + span.start,
                endIndex: cell.index + span.end,
                segmentId: cell.range.segmentId,
                tabId: cell.range.tabId,
              }),
              textStyle: span.style,
              fields: span.fields.join(","),
            },
          },
          stylePhase,
        ),
      );
    }
  });

  return requests;
}

/**
 * Locate the table created by the previous cycle.
 *
 * Identified by position: it is the first table starting at or after the anchor. Tables carry no
 * content of their own to address by, and this runs immediately after creating it, so nothing
 * else can plausibly have appeared in between.
 */
function findTableAfter(document: ParsedDocument, index: number, tabId: string): TableInfo | undefined {
  return document.tables
    .filter((t) => t.range.tabId === tabId && t.range.startIndex >= index)
    .sort((a, b) => a.range.startIndex - b.range.startIndex)[0];
}

/** Resolve where a pending table should be inserted, given the prose already written. */
function anchorForTable(document: ParsedDocument, pending: PendingTable, fallback: Address): DocRange {
  if (pending.afterBlockText) {
    try {
      const found = resolveAddress(document, { kind: "text", query: pending.afterBlockText });
      if (found.block) {
        // Immediately after the anchoring paragraph, before whatever follows it.
        return { ...found.block.range, startIndex: found.block.range.endIndex, endIndex: found.block.range.endIndex };
      }
    } catch {
      // The anchor text was ambiguous or has already been edited; fall through to the caller's
      // position rather than failing the whole write for a placement detail.
    }
  }
  const found = resolveAddress(document, fallback);
  return found.block
    ? { ...found.block.range, startIndex: found.block.range.endIndex, endIndex: found.block.range.endIndex }
    : found.range;
}

export interface WriteMarkdownOptions extends MutationOptions {
  /** Where the fragment goes. */
  position: Address;
  /** Insert immediately after the resolved block rather than at the resolved position itself. */
  after?: boolean;
}

/** Parse, compile and write a Markdown fragment, including any tables it contains. */
export async function writeMarkdown(
  documentId: string,
  markdown: string,
  options: WriteMarkdownOptions,
): Promise<WriteMarkdownResult> {
  const blocks = parseMarkdown(markdown);
  if (blocks.length === 0) {
    throw new Error("The Markdown contained no content to write.");
  }

  let insertedCharacters = 0;
  let pendingTables: PendingTable[] = [];
  let cycles = 0;

  const first = await mutate(
    documentId,
    (document) => {
      const found = resolveAddress(document, options.position);
      const anchor: DocRange =
        options.after && found.block
          ? { ...found.block.range, startIndex: found.block.range.endIndex, endIndex: found.block.range.endIndex }
          : { ...found.range, endIndex: found.range.startIndex };

      const compiled = compileMarkdown(blocks, anchor);
      insertedCharacters = compiled.text.length;
      pendingTables = compiled.pendingTables;
      return compiled.requests;
    },
    { ...options, description: `write markdown into ${documentId}` },
  );
  cycles += 1;

  let lastRevision = first.toRevisionId;
  let tablesCreated = 0;

  for (const pending of pendingTables) {
    const rows = pending.rows.length;
    const columns = Math.max(...pending.rows.map((r) => r.length), 0);
    if (rows === 0 || columns === 0) continue;

    let insertedAt = 0;
    let tabId = "";

    const created = await mutate(
      documentId,
      (document) => {
        const anchor = anchorForTable(document, pending, options.position);
        insertedAt = anchor.startIndex;
        tabId = anchor.tabId;
        return [
          at(anchor.startIndex, {
            insertTable: {
              location: { index: anchor.startIndex, segmentId: anchor.segmentId, tabId: anchor.tabId },
              rows,
              columns,
            },
          }),
        ];
      },
      { ...options, description: `create ${rows}x${columns} table in ${documentId}` },
    );
    cycles += 1;
    lastRevision = created.toRevisionId;
    tablesCreated += 1;

    const filled = await mutate(
      documentId,
      (document) => {
        const table = findTableAfter(document, insertedAt, tabId);
        if (!table) return [];
        return fillTableRequests(table, pending, document);
      },
      { ...options, description: `fill table in ${documentId}` },
    );
    cycles += 1;
    if (filled.requestCount > 0) lastRevision = filled.toRevisionId;
  }

  return {
    insertedCharacters,
    tablesCreated,
    fromRevisionId: first.fromRevisionId,
    toRevisionId: lastRevision,
    cycles,
  };
}
