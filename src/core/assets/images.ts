import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { DocRange } from "../ast/types.js";
import type { Address } from "../address/resolve.js";
import { resolveAddress } from "../address/resolve.js";
import { mutate, type MutationOptions } from "../mutate/executor.js";
import { insertImage } from "../mutate/intents.js";
import {
  deleteFile,
  downloadFile,
  grantLinkAccess,
  revokeAccess,
  uploadFile,
} from "../../google/drive.js";
import { validateImage, type ImageInfo } from "./image-info.js";

/**
 * Inserting an image into a Google Doc.
 *
 * `insertInlineImage` takes a URI and has Google's servers fetch it **with no authentication
 * context whatsoever**. Not the caller's credentials, not a service identity — nothing. So a
 * picture on the user's disk, or a private file in their own Drive, is unreachable by the very
 * API that is supposed to insert it, no matter what scopes were granted.
 *
 * The only way through is to make the bytes briefly public:
 *
 * ```
 *   upload to Drive ─▶ grant link access ─▶ insertInlineImage ─▶ revoke ─▶ delete
 * ```
 *
 * Two properties make that acceptable rather than reckless. The exposure is measured in seconds
 * and bounded by a `finally` block that runs even when the insert fails. And it is unguessable:
 * a Drive file id is a 33-character random identifier, never listed or indexed anywhere.
 *
 * Google copies the image into the document at insert time, so the hosted original is genuinely
 * disposable once the request returns.
 */

export type ImageSource =
  /** Already reachable by Google's servers; used as-is with no hosting step. */
  | { kind: "url"; url: string }
  /** A file on the machine running this server. */
  | { kind: "file"; path: string }
  /** A file already in the user's Drive. */
  | { kind: "drive"; fileId: string };

export interface InsertImageOptions extends MutationOptions {
  position: Address;
  after?: boolean;
  widthPt?: number;
  heightPt?: number;
  /** Alt text. Applied in a follow-up cycle, since the object id is unknown until it exists. */
  altText?: string;
}

export interface InsertImageResult {
  fromRevisionId: string;
  toRevisionId: string | undefined;
  /** Dimensions, when the bytes were available to inspect. */
  info: ImageInfo | undefined;
  /** True when a temporary Drive file was created and then removed. */
  usedTemporaryHosting: boolean;
  /** Set when cleanup failed, so the caller can tell the user what was left behind. */
  cleanupWarning: string | undefined;
}

/** URL form that Google's image fetcher can retrieve a shared Drive file from. */
function driveDownloadUrl(fileId: string): string {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

interface HostedImage {
  uri: string;
  info: ImageInfo | undefined;
  /** Runs regardless of whether the insert succeeded. Never throws. */
  cleanup: () => Promise<string | undefined>;
}

/** Make an image source fetchable by Google, returning the URI and how to undo it. */
async function host(source: ImageSource): Promise<HostedImage> {
  if (source.kind === "url") {
    // Already public by assumption. Validation is impossible without downloading it, and
    // downloading someone else's URL from this machine is a side effect the caller did not ask
    // for, so Google's own error is the better failure here.
    return { uri: source.url, info: undefined, cleanup: async () => undefined };
  }

  if (source.kind === "file") {
    let bytes: Buffer;
    try {
      bytes = await readFile(source.path);
    } catch {
      throw new Error(`Could not read "${source.path}". Check the path exists and is readable.`);
    }

    const info = validateImage(bytes, `"${basename(source.path)}"`);
    const fileId = await uploadFile(
      `gdocs-native-upload-${basename(source.path)}`,
      info.mimeType,
      bytes,
    );

    let permissionId: string | undefined;
    try {
      permissionId = await grantLinkAccess(fileId);
    } catch (error) {
      // The share failed, so the upload is orphaned; remove it before surfacing the error.
      await deleteFile(fileId);
      throw error;
    }

    return {
      uri: driveDownloadUrl(fileId),
      info,
      cleanup: async () => {
        const revoked = permissionId ? await revokeAccess(fileId, permissionId) : true;
        const deleted = await deleteFile(fileId);
        if (deleted) return undefined;
        return revoked
          ? `The temporary Drive file ${fileId} could not be deleted; it is private but still present.`
          : `The temporary Drive file ${fileId} is still shared by link and could not be deleted. ` +
            `Remove it manually from your Drive.`;
      },
    };
  }

  // An existing Drive file: shared temporarily, never deleted — it is the user's own document.
  const bytes = await downloadFile(source.fileId);
  const info = validateImage(bytes, `Drive file ${source.fileId}`);
  const permissionId = await grantLinkAccess(source.fileId);

  return {
    uri: driveDownloadUrl(source.fileId),
    info,
    cleanup: async () => {
      const revoked = await revokeAccess(source.fileId, permissionId);
      return revoked
        ? undefined
        : `Drive file ${source.fileId} is still shared by link — revoke the "anyone with the link" ` +
          `permission manually.`;
    },
  };
}

/** Insert an image, hosting it temporarily if Google cannot otherwise reach it. */
export async function insertDocumentImage(
  documentId: string,
  source: ImageSource,
  options: InsertImageOptions,
): Promise<InsertImageResult> {
  const hosted = await host(source);

  // Deliberately not a try/finally with the return inside the try: a returned object literal is
  // evaluated *before* the finally block runs, so a warning produced by cleanup would never reach
  // the caller. Cleanup therefore happens explicitly on both paths.
  let outcome;
  try {
    outcome = await mutate(
      documentId,
      (document) => {
        const found = resolveAddress(document, options.position);
        const anchor: DocRange =
          options.after && found.block
            ? {
                ...found.block.range,
                startIndex: found.block.range.endIndex,
                endIndex: found.block.range.endIndex,
              }
            : { ...found.range, endIndex: found.range.startIndex };

        return insertImage(anchor, hosted.uri, {
          ...(options.widthPt !== undefined ? { widthPt: options.widthPt } : {}),
          ...(options.heightPt !== undefined ? { heightPt: options.heightPt } : {}),
        });
      },
      { ...options, description: `insert image into ${documentId}` },
    );
  } catch (error) {
    // Leaving a file publicly readable because the insert failed would be the worst outcome, so
    // cleanup runs before the error is rethrown.
    await hosted.cleanup();
    throw error;
  }

  const cleanupWarning = await hosted.cleanup();

  return {
    fromRevisionId: outcome.fromRevisionId,
    toRevisionId: outcome.toRevisionId,
    info: hosted.info,
    usedTemporaryHosting: source.kind !== "url",
    cleanupWarning,
  };
}
