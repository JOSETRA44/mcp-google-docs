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
  /** Plain text with Docs' control characters normalized away. May be empty for image blocks. */
  text: string;
  /** Heading level 1-6, only for `kind === "heading"`. */
  level?: number;
  /** Nesting depth for list items, 0-based. */
  listDepth?: number;
  /** True when the list item is ordered (numbered) rather than bulleted. */
  ordered?: boolean;
  range: DocRange;
  path: BlockPath;
  /** Named style, e.g. "HEADING_1", "NORMAL_TEXT", "TITLE". */
  namedStyleType?: string;
  /** Set when this block carries or is covered by unresolved suggestions. */
  hasSuggestions?: boolean;
  /** Object IDs of inline images contained in this block. */
  inlineObjectIds?: string[];
}

/** A table, kept alongside blocks because tables need structural (not textual) addressing. */
export interface TableInfo {
  id: string;
  range: DocRange;
  rows: number;
  columns: number;
  path: BlockPath;
  /** Block IDs of every cell, in row-major order. */
  cellBlockIds: string[][];
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
