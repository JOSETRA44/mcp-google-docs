import type { docs_v1 } from "googleapis";
import type { ParsedDocument } from "./ast/types.js";
import { walkDocument } from "./ast/walk.js";
import { assignBlockIds, assignTableIds } from "./address/blockId.js";
import { getDocument } from "../google/docs.js";

/**
 * Compose a raw Google document into the model everything else works against.
 *
 * Parsing is deliberately cheap and stateless — no caching between calls. Every mutation re-reads
 * and re-parses, because a cached parse is a cached set of indices, and a cached index is exactly
 * the thing that goes stale the instant a collaborator types. The cost of re-reading is one HTTP
 * round trip; the cost of trusting a stale index is a corrupted document.
 */
export function parseDocument(raw: docs_v1.Schema$Document): ParsedDocument {
  const walked = walkDocument(raw);
  const blocks = assignBlockIds(walked.blocks);
  const tables = assignTableIds(walked.tables, blocks);

  return {
    documentId: raw.documentId ?? "",
    title: raw.title ?? "(untitled)",
    // `getDocument` refuses to return a document without a revision, so this is always present.
    revisionId: raw.revisionId ?? "",
    tabs: walked.tabs,
    blocks,
    tables,
    namedRanges: walked.namedRanges,
    inlineObjects: walked.inlineObjects,
    fetchedAt: Date.now(),
  };
}

/** Fetch and parse a document in one step. */
export async function loadDocument(documentId: string): Promise<ParsedDocument> {
  return parseDocument(await getDocument(documentId));
}
