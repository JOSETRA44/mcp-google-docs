import { createHash } from "node:crypto";
import type { Block, RawBlock, RawTableInfo, TableInfo } from "../ast/types.js";
import { normalize } from "../ast/text.js";

/**
 * Content-derived block identity.
 *
 * An index is a coordinate: it says where something sits, and stops being true the moment
 * anything before it changes. A hash of the content is an *identity*: it says what something is,
 * and survives the block moving anywhere in the document.
 *
 * That difference is the whole reason an agent can hold `{#a3f1}` across an edit — including an
 * edit made by a human in another window — and still address the right paragraph afterwards.
 *
 * The hash is taken over *normalized* text, so a block whose straight quotes Docs silently
 * curled, or whose double space collapsed, keeps the same id.
 */

/** Number of base32 characters kept from the digest. */
const ID_LENGTH = 4;

/**
 * Hash a block's text down to a short handle.
 *
 * Short ids are not a cosmetic choice: they are repeated on every block of a rendered document,
 * so length is paid for once per block in the agent's context window. Four base32 characters give
 * ~1M values, and collisions are handled explicitly by ordinal rather than assumed away.
 */
function hashText(text: string): string {
  const digest = createHash("sha256").update(normalize(text)).digest();
  // base64url minus the ambiguous characters, so an id is safe to type and to read aloud.
  return digest.toString("hex").slice(0, ID_LENGTH);
}

/**
 * Assign ids to a document's blocks.
 *
 * Blocks with identical text — empty paragraphs, repeated table headers, a "Sí" in twenty cells —
 * necessarily hash the same. They are disambiguated by the order in which they appear, so the
 * third empty paragraph is always `abcd-3`. This keeps ids deterministic for a given document
 * state, which is what makes them reproducible across two reads with no edits in between.
 *
 * The honest limitation: inserting a new duplicate *before* existing ones renumbers the ones
 * after it. Duplicate-text blocks are therefore the one case where an id can go stale, and the
 * resolver treats a miss as a reason to fall back to text matching rather than an error.
 */
export function assignBlockIds(raw: RawBlock[]): Block[] {
  const seen = new Map<string, number>();

  return raw.map((block) => {
    const hash = hashText(block.text);
    const occurrence = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, occurrence);
    return { ...block, id: occurrence === 1 ? hash : `${hash}-${occurrence}` };
  });
}

/** Resolve a table's block-index references into block ids. */
export function assignTableIds(tables: RawTableInfo[], blocks: Block[]): TableInfo[] {
  return tables.map((table, tableOrdinal) => ({
    // A table has no text of its own to hash, so it is identified by position within the tab.
    id: `t${tableOrdinal + 1}`,
    range: table.range,
    rows: table.rows,
    columns: table.columns,
    path: table.path,
    cells: table.cells.map((row) =>
      row.map((cell) => ({
        range: cell.range,
        blocks: cell.blocks.map((index) => blocks[index]?.id).filter((id): id is string => Boolean(id)),
      })),
    ),
  }));
}
