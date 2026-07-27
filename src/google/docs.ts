import type { docs_v1 } from "googleapis";
import { getGoogleClients } from "./clients.js";
import { normalizeGoogleError } from "./errors.js";
import { withRetry } from "./retry.js";

/**
 * Typed access to the Docs API, with the correctness invariants enforced in one place.
 *
 * Two of those invariants are silent-corruption traps that are easy to get wrong at a call site
 * and impossible to notice afterwards, so they are not optional parameters here — they are
 * baked in:
 *
 *  1. **`suggestionsViewMode` must be `SUGGESTIONS_INLINE`.** It is the only mode whose indices
 *     are valid for `batchUpdate`. Every other mode returns indices computed against a *preview*
 *     of the document with suggestions applied or stripped. Using them to build an edit writes
 *     to a position that does not exist in the real document.
 *
 *  2. **`includeTabsContent` must be true.** Without it Google returns only the first tab, in the
 *     legacy `document.body` field. An edit built from that read silently targets tab one no
 *     matter which tab the agent meant.
 */

/** Result of a mutation, carrying both revisions so a caller can report exactly what moved. */
export interface BatchUpdateResult {
  documentId: string;
  /** Revision the edit was computed against. */
  fromRevisionId: string;
  /** Revision produced by the edit, when Google reports one. */
  toRevisionId: string | undefined;
  replies: docs_v1.Schema$Response[];
}

export type WriteMode = "direct" | "suggest";

export interface WriteOptions {
  /**
   * The revision the edit was computed against.
   *
   * Sent as `targetRevisionId`, which asks Google to *transform* our requests against any
   * collaborator edits committed since that revision — server-side operational transformation.
   * This is what makes concurrent human editing safe rather than merely detectable.
   */
  targetRevisionId: string;
  /**
   * Fail loudly instead of merging. Sends `requiredRevisionId`, so any drift at all rejects the
   * whole batch with a 400. Reserved for edits where a merged outcome would be worse than no
   * outcome.
   */
  strict?: boolean;
  /**
   * `"suggest"` writes as tracked suggestions rather than committed edits. Requires Developer
   * Preview; the capability probe decides whether it is offered.
   */
  mode?: WriteMode;
}

/** Fetch a document with the invariants above enforced. */
export async function getDocument(documentId: string): Promise<docs_v1.Schema$Document> {
  const { docs } = await getGoogleClients();

  return withRetry(
    async () => {
      const response = await docs.documents.get({
        documentId,
        includeTabsContent: true,
        suggestionsViewMode: "SUGGESTIONS_INLINE",
      });
      const document = response.data;
      if (!document.revisionId) {
        // Every write needs a revision to transform against. A document without one cannot be
        // edited safely, and failing here beats discovering it mid-batch.
        throw new Error("Google returned a document with no revisionId; cannot edit safely.");
      }
      return document;
    },
    `Could not read document ${documentId}`,
  );
}

/**
 * Apply a batch of requests.
 *
 * Requests are sent in the order given. Callers are responsible for ordering them by *descending*
 * index, so that the index shifts each request causes fall entirely after the positions the
 * remaining requests refer to. `planRequests` in `core/mutate` owns that ordering.
 */
export async function batchUpdate(
  documentId: string,
  requests: docs_v1.Schema$Request[],
  options: WriteOptions,
): Promise<BatchUpdateResult> {
  if (requests.length === 0) {
    return {
      documentId,
      fromRevisionId: options.targetRevisionId,
      toRevisionId: options.targetRevisionId,
      replies: [],
    };
  }

  const { docs } = await getGoogleClients();

  const writeControl: docs_v1.Schema$WriteControl = options.strict
    ? { requiredRevisionId: options.targetRevisionId }
    : { targetRevisionId: options.targetRevisionId };

  if (options.mode === "suggest") {
    // `writeMode` is a Developer Preview field that the generated types do not yet describe.
    // The cast is contained here rather than at every call site.
    (writeControl as Record<string, unknown>).writeMode = "SUGGEST";
  }

  // Deliberately not wrapped in withRetry: a revision conflict must re-read and re-resolve
  // addresses before retrying, which only the mutation executor can do. Blind replay of a batch
  // built from stale indices is precisely the corruption this project exists to prevent.
  try {
    const response = await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests, writeControl },
    });

    return {
      documentId,
      fromRevisionId: options.targetRevisionId,
      toRevisionId: response.data.writeControl?.requiredRevisionId ?? undefined,
      replies: response.data.replies ?? [],
    };
  } catch (error) {
    throw normalizeGoogleError(error, `Could not update document ${documentId}`);
  }
}

/** Create an empty document and return its id. */
export async function createDocument(title: string): Promise<string> {
  const { docs } = await getGoogleClients();

  return withRetry(
    async () => {
      const response = await docs.documents.create({ requestBody: { title } });
      const id = response.data.documentId;
      if (!id) throw new Error("Google created a document but returned no documentId.");
      return id;
    },
    `Could not create document "${title}"`,
  );
}
