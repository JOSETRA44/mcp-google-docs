import { readFile, writeFile } from "node:fs/promises";
import { capabilitiesPath, ensureStateDir } from "../config/paths.js";
import { GoogleApiError } from "./errors.js";

/**
 * Runtime detection of Developer Preview features.
 *
 * Some Docs capabilities — anchored comment threads, suggestion review, `writeMode: SUGGEST` —
 * exist only for accounts enrolled in the Google Workspace Developer Preview Program. There is no
 * endpoint that reports enrollment, so the only honest way to know is to attempt the operation
 * and interpret the failure.
 *
 * Probing on every call would be wasteful and probing at startup would slow down a server that
 * may never need the feature, so detection is **lazy and cached**: the first attempt records what
 * happened, and subsequent calls read the answer from disk. A negative result is cached with an
 * expiry, because enrollment is something a user can gain between two runs and a permanently
 * cached "no" would hide it from them.
 */

export type Capability = "previewComments" | "suggestMode";

interface CapabilityRecord {
  available: boolean;
  /** When the probe ran, so a negative result can expire. */
  checkedAt: number;
}

type CapabilityCache = Partial<Record<Capability, CapabilityRecord>>;

/** How long a "not available" answer is trusted before re-probing. */
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

let memory: CapabilityCache | undefined;

async function load(): Promise<CapabilityCache> {
  if (memory) return memory;
  try {
    memory = JSON.parse(await readFile(capabilitiesPath(), "utf8")) as CapabilityCache;
  } catch {
    memory = {};
  }
  return memory;
}

async function save(cache: CapabilityCache): Promise<void> {
  memory = cache;
  try {
    await ensureStateDir();
    await writeFile(capabilitiesPath(), JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // An unwritable cache costs a repeated probe, nothing more.
  }
}

/** Read a cached answer, treating a stale negative as unknown. */
export async function getCached(capability: Capability): Promise<boolean | undefined> {
  const cache = await load();
  const record = cache[capability];
  if (!record) return undefined;
  if (record.available) return true;
  return Date.now() - record.checkedAt < NEGATIVE_TTL_MS ? false : undefined;
}

export async function record(capability: Capability, available: boolean): Promise<void> {
  const cache = await load();
  cache[capability] = { available, checkedAt: Date.now() };
  await save(cache);
}

/** Drop the in-process cache so the next read comes from disk. Used by tests. */
export function resetCapabilityCache(): void {
  memory = undefined;
}

/** Whether a failure means "this account is not enrolled" rather than "this call was wrong". */
export function indicatesMissingPreview(error: unknown): boolean {
  if (!(error instanceof GoogleApiError)) return false;
  if (error.kind === "preview_required") return true;
  // Google also rejects an unknown request field with a plain 400 mentioning it, which is what a
  // non-enrolled account sees for a preview-only request type.
  return (
    error.kind === "invalid_request" &&
    /unknown name|invalid json payload|not supported|cannot find field/i.test(error.message)
  );
}

/**
 * Determine whether `writeControl.writeMode: SUGGEST` genuinely produces tracked suggestions.
 *
 * This cannot be learned by attempting it on the user's document and watching for an error,
 * because **Google does not error**. An account without Developer Preview access has the field
 * silently dropped and the edit committed as an ordinary write. The caller is told it succeeded,
 * believes it made a reviewable proposal, and has in fact changed the document irreversibly.
 *
 * So the probe runs against a throwaway document that is created and deleted here: write a word
 * in suggest mode, read it back, and check whether Docs recorded it as a suggested insertion. The
 * user's own documents are never involved, and the answer is cached so this happens at most once.
 */
async function probeSuggestMode(): Promise<boolean> {
  const { createDocument, getDocument, batchUpdate } = await import("./docs.js");
  const { deleteFile } = await import("./drive.js");

  let probeDocumentId: string | undefined;
  try {
    probeDocumentId = await createDocument("gdocs-native capability probe (safe to delete)");
    const before = await getDocument(probeDocumentId);

    await batchUpdate(
      probeDocumentId,
      [{ insertText: { location: { index: 1 }, text: "probe" } }],
      { targetRevisionId: before.revisionId!, mode: "suggest" },
    );

    const after = await getDocument(probeDocumentId);
    // A genuine suggestion carries insertion ids on the text run. A committed write has none.
    return JSON.stringify(after.body ?? {}).includes("suggestedInsertionIds");
  } catch {
    // A probe that cannot run is treated as "unavailable": refusing is always safer than
    // assuming a capability whose absence silently commits edits.
    return false;
  } finally {
    if (probeDocumentId) await deleteFile(probeDocumentId);
  }
}

/** Probes, keyed by capability. Only capabilities that fail silently need one. */
const PROBES: Partial<Record<Capability, () => Promise<boolean>>> = {
  suggestMode: probeSuggestMode,
};

export class PreviewUnavailableError extends Error {
  constructor(feature: string) {
    super(
      `${feature} needs Google Workspace Developer Preview access, which this account does not ` +
        `have.\n\nJoin the program at https://developers.google.com/workspace/preview and the ` +
        `feature will start working automatically — no reconfiguration needed.`,
    );
    this.name = "PreviewUnavailableError";
  }
}

/**
 * Run an operation that needs a preview capability, learning from the outcome.
 *
 * `fallback` is used when the capability is known to be missing. Where no fallback exists the
 * caller gets `PreviewUnavailableError`, whose message tells the user exactly how to gain the
 * feature — an actionable refusal rather than an opaque 400.
 */
export async function withCapability<T>(
  capability: Capability,
  feature: string,
  operation: () => Promise<T>,
  fallback?: () => Promise<T>,
): Promise<T> {
  let known = await getCached(capability);

  // Where a capability fails *silently*, the answer must be established before the operation
  // runs — learning from the operation's own failure only works when there is a failure.
  const probe = PROBES[capability];
  if (known === undefined && probe) {
    known = await probe();
    await record(capability, known);
  }

  if (known === false) {
    if (fallback) return fallback();
    throw new PreviewUnavailableError(feature);
  }

  try {
    const result = await operation();
    // Only record success when it was previously unknown, to avoid a write on every call.
    if (known === undefined) await record(capability, true);
    return result;
  } catch (error) {
    if (!indicatesMissingPreview(error)) throw error;

    await record(capability, false);
    if (fallback) return fallback();
    throw new PreviewUnavailableError(feature);
  }
}
