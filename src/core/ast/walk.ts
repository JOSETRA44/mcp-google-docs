import type { docs_v1 } from "googleapis";
import type {
  BlockKind,
  BlockPath,
  DocRange,
  InlineObjectInfo,
  RawBlock,
  RawTableInfo,
  TabInfo,
  TableCellInfo,
} from "./types.js";

/**
 * Flatten Google's document tree into an ordered list of blocks.
 *
 * ## The invariant this walk exists to guarantee
 *
 * Within a block, **one character of `text` corresponds to exactly one document index.**
 *
 * That sounds automatic but is not. A paragraph is a sequence of heterogeneous elements: text
 * runs, but also inline images, page breaks, footnote references, person chips and rich links.
 * Each non-text element occupies document indices while contributing no characters — and a
 * person chip occupies *one* index while displaying a name many characters long.
 *
 * If text were built by concatenating only the readable parts, then an offset found by searching
 * that text would no longer correspond to a document index, and every sub-paragraph edit after
 * the first image in a document would land in the wrong place.
 *
 * So every non-text element contributes `endIndex - startIndex` placeholder characters. The
 * width is read from the element rather than assumed, which keeps the invariant true even for
 * element types whose index width is not one. With that in place, converting a text offset to a
 * document index is plain addition, everywhere, with no offset table to keep in sync.
 */

/** U+FFFC OBJECT REPLACEMENT CHARACTER — stands in for one index of non-text content. */
export const OBJECT_PLACEHOLDER = "￼";

export interface WalkResult {
  tabs: TabInfo[];
  blocks: RawBlock[];
  tables: RawTableInfo[];
  namedRanges: Record<string, DocRange[]>;
  inlineObjects: Record<string, InlineObjectInfo>;
}

/** Google's heading style names mapped to outline levels. */
function headingLevel(namedStyleType: string | null | undefined): number | undefined {
  if (!namedStyleType) return undefined;
  // TITLE and SUBTITLE are distinct styles in Docs but behave as the top of the outline. The
  // original style name is preserved on the block, so nothing is lost by levelling them here.
  if (namedStyleType === "TITLE") return 1;
  if (namedStyleType === "SUBTITLE") return 2;
  const match = /^HEADING_([1-6])$/.exec(namedStyleType);
  return match ? Number(match[1]) : undefined;
}

/** Whether a bullet's list definition renders numbers rather than symbols. */
function isOrderedList(
  lists: Record<string, docs_v1.Schema$List> | undefined,
  listId: string | null | undefined,
  nestingLevel: number,
): boolean {
  if (!lists || !listId) return false;
  const level = lists[listId]?.listProperties?.nestingLevels?.[nestingLevel];
  const glyphType = level?.glyphType;
  return Boolean(glyphType && glyphType !== "GLYPH_TYPE_UNSPECIFIED" && glyphType !== "NONE");
}

/** googleapis models absent maps as `null` rather than omitting them, so every lookup admits it. */
type Dict<T> = Record<string, T> | null | undefined;

interface SegmentContext {
  tabId: string;
  segmentId: string;
  tabOrdinal: number;
  table?: { rowIndex: number; columnIndex: number };
}

class Walker {
  readonly blocks: RawBlock[] = [];
  readonly tables: RawTableInfo[] = [];
  readonly tabs: TabInfo[] = [];
  readonly namedRanges: Record<string, DocRange[]> = {};
  readonly inlineObjects: Record<string, InlineObjectInfo> = {};

  /** List definitions for the tab currently being walked. */
  private lists: Record<string, docs_v1.Schema$List> | undefined;

  walk(document: docs_v1.Schema$Document): void {
    if (document.tabs?.length) {
      let ordinal = 0;
      const visit = (tab: docs_v1.Schema$Tab, depth: number, parentTabId?: string): void => {
        const tabId = tab.tabProperties?.tabId ?? "";
        this.tabs.push({
          tabId,
          title: tab.tabProperties?.title ?? "(untitled tab)",
          ordinal,
          depth,
          ...(parentTabId ? { parentTabId } : {}),
        });
        const current = ordinal;
        ordinal++;

        if (tab.documentTab) this.walkDocumentTab(tab.documentTab, tabId, current);
        // Child tabs are walked immediately after their parent so document order in `blocks`
        // matches the order a reader sees in the tab sidebar.
        for (const child of tab.childTabs ?? []) visit(child, depth + 1, tabId);
      };
      for (const tab of document.tabs) visit(tab, 0);
      return;
    }

    // Defensive fallback: `includeTabsContent` should always populate `tabs`, but a document read
    // without it exposes only the first tab through the legacy top-level fields.
    this.lists = document.lists ?? undefined;
    this.collectInlineObjects(document.inlineObjects);
    this.collectNamedRanges(document.namedRanges);
    this.walkContent(document.body?.content, { tabId: "", segmentId: "", tabOrdinal: 0 });
    this.walkSegments(document.headers, document.footers, document.footnotes, "", 0);
  }

  private walkDocumentTab(tab: docs_v1.Schema$DocumentTab, tabId: string, tabOrdinal: number): void {
    this.lists = tab.lists ?? undefined;
    this.collectInlineObjects(tab.inlineObjects);
    this.collectNamedRanges(tab.namedRanges);
    this.walkContent(tab.body?.content, { tabId, segmentId: "", tabOrdinal });
    this.walkSegments(tab.headers, tab.footers, tab.footnotes, tabId, tabOrdinal);
  }

  /**
   * Walk headers, footers and footnotes.
   *
   * These are separate index spaces: index 42 in a header has nothing to do with index 42 in the
   * body. The segment id is what disambiguates them, and omitting it from a request silently
   * targets the body instead.
   */
  private walkSegments(
    headers: Dict<docs_v1.Schema$Header>,
    footers: Dict<docs_v1.Schema$Footer>,
    footnotes: Dict<docs_v1.Schema$Footnote>,
    tabId: string,
    tabOrdinal: number,
  ): void {
    for (const [segmentId, header] of Object.entries(headers ?? {})) {
      this.walkContent(header.content, { tabId, segmentId, tabOrdinal });
    }
    for (const [segmentId, footer] of Object.entries(footers ?? {})) {
      this.walkContent(footer.content, { tabId, segmentId, tabOrdinal });
    }
    for (const [segmentId, footnote] of Object.entries(footnotes ?? {})) {
      this.walkContent(footnote.content, { tabId, segmentId, tabOrdinal });
    }
  }

  private collectInlineObjects(objects: Dict<docs_v1.Schema$InlineObject>): void {
    for (const [objectId, object] of Object.entries(objects ?? {})) {
      const embedded = object.inlineObjectProperties?.embeddedObject;
      const size = embedded?.size;
      this.inlineObjects[objectId] = {
        objectId,
        contentUri: embedded?.imageProperties?.contentUri ?? undefined,
        sourceUri: embedded?.imageProperties?.sourceUri ?? undefined,
        altTitle: embedded?.title ?? undefined,
        altDescription: embedded?.description ?? undefined,
        widthPt: size?.width?.magnitude ?? undefined,
        heightPt: size?.height?.magnitude ?? undefined,
      };
    }
  }

  private collectNamedRanges(named: Dict<docs_v1.Schema$NamedRanges>): void {
    for (const [name, group] of Object.entries(named ?? {})) {
      const ranges = (group.namedRanges ?? []).flatMap((entry) =>
        (entry.ranges ?? []).map<DocRange>((range) => ({
          startIndex: range.startIndex ?? 0,
          endIndex: range.endIndex ?? 0,
          segmentId: range.segmentId ?? "",
          tabId: range.tabId ?? "",
        })),
      );
      // A named range can be split by edits, so ranges accumulate rather than overwrite.
      (this.namedRanges[name] ??= []).push(...ranges);
    }
  }

  private walkContent(
    content: docs_v1.Schema$StructuralElement[] | undefined,
    context: SegmentContext,
  ): void {
    let contentOrdinal = 0;
    for (const element of content ?? []) {
      this.walkStructuralElement(element, context, contentOrdinal);
      contentOrdinal++;
    }
  }

  private walkStructuralElement(
    element: docs_v1.Schema$StructuralElement,
    context: SegmentContext,
    contentOrdinal: number,
  ): void {
    const path: BlockPath = {
      tabOrdinal: context.tabOrdinal,
      contentOrdinal,
      ...(context.table ? { table: context.table } : {}),
    };

    if (element.paragraph) {
      this.emitParagraph(element, element.paragraph, context, path);
      return;
    }

    if (element.table) {
      this.emitTable(element, element.table, context, path);
      return;
    }

    if (element.sectionBreak) {
      this.emitStructural(element, context, path, "sectionBreak", "");
      return;
    }

    if (element.tableOfContents) {
      this.emitStructural(element, context, path, "tableOfContents", "");
      // The table of contents holds its own structural content; walking it keeps its entries
      // addressable rather than leaving an opaque hole in the block list.
      this.walkContent(element.tableOfContents.content, context);
    }
  }

  private rangeOf(element: { startIndex?: number | null; endIndex?: number | null }, context: SegmentContext): DocRange {
    return {
      // Docs omits `startIndex` when it is zero, so a missing value means 0 rather than unknown.
      startIndex: element.startIndex ?? 0,
      endIndex: element.endIndex ?? 0,
      segmentId: context.segmentId,
      tabId: context.tabId,
    };
  }

  private emitStructural(
    element: docs_v1.Schema$StructuralElement,
    context: SegmentContext,
    path: BlockPath,
    kind: BlockKind,
    text: string,
  ): void {
    const range = this.rangeOf(element, context);
    this.blocks.push({ kind, text, range, textRange: range, path });
  }

  private emitParagraph(
    element: docs_v1.Schema$StructuralElement,
    paragraph: docs_v1.Schema$Paragraph,
    context: SegmentContext,
    path: BlockPath,
  ): void {
    const range = this.rangeOf(element, context);

    let raw = "";
    const inlineObjectRefs: { offset: number; objectId: string }[] = [];
    let hasSuggestions = false;

    for (const child of paragraph.elements ?? []) {
      const width = (child.endIndex ?? 0) - (child.startIndex ?? 0);

      if (child.textRun) {
        raw += child.textRun.content ?? "";
        if (child.textRun.suggestedInsertionIds?.length || child.textRun.suggestedDeletionIds?.length) {
          hasSuggestions = true;
        }
        continue;
      }

      if (child.inlineObjectElement?.inlineObjectId) {
        // `raw.length` is the offset the placeholder is about to occupy, which is exactly where
        // the renderer must substitute this image back in.
        inlineObjectRefs.push({ offset: raw.length, objectId: child.inlineObjectElement.inlineObjectId });
      }

      // Every other element type — images, breaks, footnote references, equations, person chips,
      // rich links — becomes exactly as many placeholder characters as it occupies indices.
      raw += OBJECT_PLACEHOLDER.repeat(Math.max(0, width));
    }

    // The paragraph mark is a real character occupying a real index. Excluding it from
    // `textRange` is what stops a text rewrite from eating the paragraph break.
    const endsWithMark = raw.endsWith("\n");
    const text = endsWithMark ? raw.slice(0, -1) : raw;
    const textRange: DocRange = endsWithMark
      ? { ...range, endIndex: Math.max(range.startIndex, range.endIndex - 1) }
      : range;

    const styleType = paragraph.paragraphStyle?.namedStyleType;
    const level = headingLevel(styleType);
    const bullet = paragraph.bullet;

    let kind: BlockKind = "paragraph";
    if (bullet) kind = "listItem";
    else if (level !== undefined) kind = "heading";
    else if (context.table) kind = "tableCell";

    this.blocks.push({
      kind,
      text,
      range,
      textRange,
      path,
      ...(level !== undefined ? { level } : {}),
      ...(bullet
        ? {
            listDepth: bullet.nestingLevel ?? 0,
            ordered: isOrderedList(this.lists, bullet.listId, bullet.nestingLevel ?? 0),
          }
        : {}),
      ...(styleType ? { namedStyleType: styleType } : {}),
      ...(hasSuggestions ? { hasSuggestions } : {}),
      ...(inlineObjectRefs.length ? { inlineObjectRefs } : {}),
    });
  }

  private emitTable(
    element: docs_v1.Schema$StructuralElement,
    table: docs_v1.Schema$Table,
    context: SegmentContext,
    path: BlockPath,
  ): void {
    const range = this.rangeOf(element, context);
    const cells: TableCellInfo<number>[][] = [];

    const rows = table.tableRows ?? [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      const rowCells: TableCellInfo<number>[] = [];

      const cellList = row.tableCells ?? [];
      for (let columnIndex = 0; columnIndex < cellList.length; columnIndex++) {
        const cell = cellList[columnIndex]!;
        // Record where this cell's blocks will start so they can be referenced back after the
        // whole table has been walked.
        const firstBlockIndex = this.blocks.length;

        this.walkContent(cell.content, { ...context, table: { rowIndex, columnIndex } });

        const blockIndices: number[] = [];
        for (let i = firstBlockIndex; i < this.blocks.length; i++) blockIndices.push(i);

        rowCells.push({ range: this.rangeOf(cell, context), blocks: blockIndices });
      }
      cells.push(rowCells);
    }

    this.tables.push({
      range,
      rows: table.rows ?? rows.length,
      columns: table.columns ?? (cells[0]?.length ?? 0),
      path,
      cells,
    });
  }
}

/** Flatten a document into blocks, tables, tabs, named ranges and inline objects. */
export function walkDocument(document: docs_v1.Schema$Document): WalkResult {
  const walker = new Walker();
  walker.walk(document);
  return {
    tabs: walker.tabs,
    blocks: walker.blocks,
    tables: walker.tables,
    namedRanges: walker.namedRanges,
    inlineObjects: walker.inlineObjects,
  };
}
