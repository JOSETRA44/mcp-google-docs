import type { docs_v1 } from "googleapis";
import type { DocRange } from "../ast/types.js";

/**
 * Request planning and ordering.
 *
 * Google applies the requests in a batch **sequentially**, each against the document as the
 * previous one left it. So an insertion at index 100 shifts every index above 100 for every
 * request that follows.
 *
 * The standard fix is to order requests by descending index: each request then acts at a
 * position no later than any request still to come, so the shifts it causes fall entirely
 * *after* the region the remaining requests address, and no arithmetic is needed anywhere.
 *
 * Doing that requires knowing the index each request acts at — which cannot be read back out of a
 * `Schema$Request` without a switch over all 44 variants. So every request is planned together
 * with its anchor index, declared by whoever built it.
 */

export interface PlannedRequest {
  /** The document index this request acts at. Used solely for ordering. */
  at: number;
  request: docs_v1.Schema$Request;
}

/** Pair a request with the index it acts at. */
export function at(index: number, request: docs_v1.Schema$Request): PlannedRequest {
  return { at: index, request };
}

/**
 * Order requests for safe sequential application.
 *
 * The sort must be **stable**: several requests can legitimately share an anchor — a delete and
 * the insert that replaces it both act at the same index — and their relative order is what makes
 * the replacement come out right. JavaScript's sort has been required to be stable since ES2019,
 * so the order in which a planner emitted them is preserved.
 */
export function orderRequests(planned: PlannedRequest[]): docs_v1.Schema$Request[] {
  return [...planned].sort((a, b) => b.at - a.at).map((p) => p.request);
}

/** Convert an internal range to the Docs API's range shape. */
export function toApiRange(range: DocRange): docs_v1.Schema$Range {
  return {
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    // The empty string is a meaningful value here — it denotes the document body — so it is sent
    // explicitly rather than omitted.
    segmentId: range.segmentId,
    tabId: range.tabId,
  };
}

/** Convert an internal position to the Docs API's location shape. */
export function toApiLocation(range: DocRange, index = range.startIndex): docs_v1.Schema$Location {
  return { index, segmentId: range.segmentId, tabId: range.tabId };
}
