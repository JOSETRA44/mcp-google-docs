/**
 * The normalized document model that sits between Google's AST and the agent.
 *
 * Google's model is a tree of `StructuralElement`s addressed by absolute integer indices that
 * shift on every edit. This model flattens that tree into an ordered list of `Block`s, each
 * carrying a content-derived `id` that survives index shifts, and the concrete `DocRange` that
 * was true at the moment of the read.
 *
 * The rule that makes this safe: a `DocRange` is only ever valid for the `revisionId` it was
 * read at. Ranges are never persisted across writes — they are recomputed every cycle. Only
 * `id` is allowed to cross a write boundary.
 */

/** A concrete location in a document, valid only for one specific revision. */
export interface DocRange {
  startIndex: number;
  endIndex: number;
  /**
   * Google's segment addressing. The empty string means the document body; otherwise this is a
   * headerId, footerId, or footnoteId. Indices are scoped *per segment* — index 42 in a header
   * is unrelated to index 42 in the body, so a range without its segmentId is meaningless.
   */
  segmentId: string;
  /**
   * Which tab this range lives in. Requests that omit a tabId silently apply to the FIRST tab,
   * which is a quiet way to corrupt a multi-tab document, so we always carry it explicitly.
   */
  tabId: string;
}

export type BlockKind =
  | "heading"
  | "paragraph"
  | "listItem"
  | "tableCell"
  | "sectionBreak"
  | "tableOfContents"
  | "image"
  | "horizontalRule"
  | "pageBreak"
  | "equation";

/** Where a block sits structurally, used for ordering and for "insert after X" semantics. */
export interface BlockPath {
  /** Index of the tab in a depth-first walk of the tab tree. */
  tabOrdinal: number;
  /** Index within the segment's content array. */
  contentOrdinal: number;
  /** For table cells: which table, row and column. */
  table?: { rowIndex: number; columnIndex: number };
}

export interface Block {
  /**
   * Content-addressed handle. Derived from a hash of the block's normalized text plus an
   * ordinal that disambiguates repeated identical text. Stable across edits elsewhere in the
   * document — this is the handle agents hold onto instead of an integer.
   */
  id: string;
  kind: BlockKind;
  /**
   * Plain text with the trailing paragraph mark removed. This is what gets matched against and
   * what gets shown to the agent.
   */
  text: string;
  /** Heading level 1-6, only for `kind === "heading"`. */
  level?: number;
  /** Nesting depth for list items, 0-based. */
  listDepth?: number;
  /** True when the list item is ordered (numbered) rather than bulleted. */
  ordered?: boolean;
  /**
   * The whole structural element, *including* the trailing paragraph mark.
   * Deleting this range removes the paragraph itself.
   */
  range: DocRange;
  /**
   * Just the text, *excluding* the trailing paragraph mark.
   *
   * Both ranges exist because picking the wrong one is the single most common way to mangle a
   * Docs edit: replacing text over `range` swallows the paragraph break and silently merges the
   * block with the one after it. Rewriting a block's text uses `textRange`; removing the block
   * entirely uses `range`.
   */
  textRange: DocRange;
  path: BlockPath;
  /** Named style, e.g. "HEADING_1", "NORMAL_TEXT", "TITLE". */
  namedStyleType?: string;
  /** Set when this block carries or is covered by unresolved suggestions. */
  hasSuggestions?: boolean;
  /** Object IDs of inline images contained in this block. */
  inlineObjectIds?: string[];
}

/**
 * A block as produced by the AST walk, before an identity has been assigned.
 *
 * The walk knows structure and position; it does not know how to name things. Deriving a stable
 * id needs a view of the whole document at once, because identical text in two places has to be
 * disambiguated by ordinal. Keeping that a separate step means the walk stays a pure structural
 * transform and the naming scheme can change without touching it.
 */
export type RawBlock = Omit<Block, "id">;

/** A table, kept alongside blocks because tables need structural (not textual) addressing. */
/** One cell. A cell holds a sequence of blocks, not a single string — cells can hold paragraphs,
 *  lists, even nested tables. */
export interface TableCellInfo<Ref> {
  range: DocRange;
  /** The blocks living inside this cell, in document order. */
  blocks: Ref[];
}

export interface TableInfo {
  id: string;
  range: DocRange;
  rows: number;
  columns: number;
  path: BlockPath;
  /** Cells in row-major order; `cells[row][column]`. */
  cells: TableCellInfo<string>[][];
}

/** A table as produced by the walk: cells reference blocks by array index, not by id. */
export interface RawTableInfo {
  range: DocRange;
  rows: number;
  columns: number;
  path: BlockPath;
  cells: TableCellInfo<number>[][];
}

/** One tab of a document, including nested child tabs flattened by depth-first ordinal. */
export interface TabInfo {
  tabId: string;
  title: string;
  ordinal: number;
  /** Depth in the tab tree; 0 for top-level tabs. */
  depth: number;
  parentTabId?: string;
}

/**
 * A fully parsed document at one revision. Everything an agent-facing tool needs to resolve an
 * address and build a request, with no further network calls.
 */
export interface ParsedDocument {
  documentId: string;
  title: string;
  /**
   * The revision this snapshot was read at. Passed back as `writeControl.targetRevisionId` so
   * Google can transform our edits against any concurrent collaborator edits.
   */
  revisionId: string;
  tabs: TabInfo[];
  blocks: Block[];
  tables: TableInfo[];
  /** Named ranges by name, usable as explicit long-lived anchors. */
  namedRanges: Record<string, DocRange[]>;
  /** Inline object metadata, keyed by objectId, for rendering and for image replacement. */
  inlineObjects: Record<string, InlineObjectInfo>;
  /** Wall-clock time of the read, used to warn when a snapshot is stale. */
  fetchedAt: number;
}

export interface InlineObjectInfo {
  objectId: string;
  /** The URI Google serves the image from. Expires, so it is refetched rather than cached. */
  contentUri?: string;
  sourceUri?: string;
  altTitle?: string;
  altDescription?: string;
  widthPt?: number;
  heightPt?: number;
}
