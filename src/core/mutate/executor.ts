import { appendFile } from "node:fs/promises";
import type { ParsedDocument } from "../ast/types.js";
import { loadDocument } from "../document.js";
import { batchUpdate, type WriteMode } from "../../google/docs.js";
import { isRevisionConflict } from "../../google/errors.js";
import { withCapability } from "../../google/capabilities.js";
import { ensureStateDir, mutationLogPath } from "../../config/paths.js";
import { orderRequests, type PlannedRequest } from "./plan.js";

/**
 * The Just-In-Time mutation cycle — the heart of the project.
 *
 * ```
 *   read  ──▶  resolve  ──▶  plan  ──▶  order  ──▶  write
 *    ▲                                                │
 *    └──────────── revision conflict ◀────────────────┘
 * ```
 *
 * Three properties make this safe, and all three are necessary:
 *
 * 1. **Indices are never cached.** The planner receives a document read moments ago and the
 *    resulting requests are sent immediately. An index that crosses a network round trip in the
 *    wrong direction is already a bug.
 *
 * 2. **The write declares the revision it was computed against.** Sent as `targetRevisionId`,
 *    which asks Google to transform the batch against whatever collaborators committed in the
 *    meantime. This is real operational transformation done by the same engine that powers the
 *    web editor — not a lock, not a last-write-wins overwrite.
 *
 * 3. **A conflict re-plans rather than replays.** When Google rejects the revision outright, the
 *    document is re-read and the addresses are resolved again from scratch. Replaying the
 *    original requests would reapply indices that are known to be stale, which is precisely the
 *    corruption this design exists to prevent.
 */

/** Builds the requests for one attempt, against a document read seconds ago. */
export type Planner = (document: ParsedDocument) => PlannedRequest[];

export interface MutationOptions {
  /** `"suggest"` writes tracked suggestions instead of committed edits. */
  mode?: WriteMode;
  /** Reject rather than merge if the document moved on at all. */
  strict?: boolean;
  /** How many times to re-read and re-plan after a revision conflict. */
  maxAttempts?: number;
  /** Human-readable summary of the intent, recorded in the mutation log. */
  description?: string;
}

export interface MutationOutcome {
  documentId: string;
  /** The revision the applied edit was computed against — the point to restore to. */
  fromRevisionId: string;
  toRevisionId: string | undefined;
  requestCount: number;
  /** How many attempts it took; above 1 means a collaborator was editing concurrently. */
  attempts: number;
  /** The document as read on the successful attempt, for reporting what was changed. */
  document: ParsedDocument;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Record every mutation so a direct write is always traceable to a restore point.
 *
 * This is the counterweight to defaulting to direct rather than suggested writes: the edit itself
 * is immediate, but the revision it started from is written down, and Drive's revision history
 * can be used to get back there. Logging failures are swallowed — losing an audit line must never
 * turn a successful edit into a reported failure.
 */
async function logMutation(outcome: MutationOutcome, description: string | undefined): Promise<void> {
  try {
    await ensureStateDir();
    const line = JSON.stringify({
      at: new Date().toISOString(),
      documentId: outcome.documentId,
      from: outcome.fromRevisionId,
      to: outcome.toRevisionId,
      requests: outcome.requestCount,
      attempts: outcome.attempts,
      ...(description ? { description } : {}),
    });
    await appendFile(mutationLogPath(), `${line}\n`, "utf8");
  } catch {
    // Intentionally ignored.
  }
}

/**
 * Run a planned mutation against a document.
 *
 * `plan` may throw — an `AddressError` when the agent's description matches nothing or matches
 * ambiguously. Those propagate immediately rather than being retried, because re-reading will not
 * make an ambiguous instruction unambiguous.
 */
export async function mutate(
  documentId: string,
  plan: Planner,
  options: MutationOptions = {},
): Promise<MutationOutcome> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let lastConflict: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const document = await loadDocument(documentId);
    const planned = plan(document);

    if (planned.length === 0) {
      return {
        documentId,
        fromRevisionId: document.revisionId,
        toRevisionId: document.revisionId,
        requestCount: 0,
        attempts: attempt,
        document,
      };
    }

    try {
      const write = () =>
        batchUpdate(documentId, orderRequests(planned), {
          targetRevisionId: document.revisionId,
          ...(options.strict !== undefined ? { strict: options.strict } : {}),
          ...(options.mode !== undefined ? { mode: options.mode } : {}),
        });

      // Suggestion mode is a Developer Preview feature. There is deliberately no fallback: an
      // agent that asked for a reviewable suggestion and silently got a committed edit instead
      // would have made an irreversible change the user never approved.
      const result =
        options.mode === "suggest"
          ? await withCapability("suggestMode", "Writing as a tracked suggestion", write)
          : await write();

      const outcome: MutationOutcome = {
        documentId,
        fromRevisionId: result.fromRevisionId,
        toRevisionId: result.toRevisionId,
        requestCount: planned.length,
        attempts: attempt,
        document,
      };

      await logMutation(outcome, options.description);
      return outcome;
    } catch (error) {
      if (!isRevisionConflict(error) || attempt === maxAttempts) throw error;
      // Loop: the next iteration re-reads and re-resolves against the document as it now stands.
      lastConflict = error;
    }
  }

  throw lastConflict ?? new Error("Mutation loop exited without applying or failing.");
}
