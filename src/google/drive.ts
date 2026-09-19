import { Readable } from "node:stream";
import { getGoogleClients } from "./clients.js";
import { withRetry } from "./retry.js";

/**
 * Drive-side operations.
 *
 * These are the capabilities that make the difference between "can edit text" and "can operate a
 * document": high-fidelity markdown export, discovery, version history, and later the asset
 * pipeline that makes image insertion possible at all.
 */

export interface DocumentSummary {
  id: string;
  name: string;
  modifiedTime: string | undefined;
  owners: string[];
  webViewLink: string | undefined;
}

const DOC_MIME = "application/vnd.google-apps.document";

/**
 * Export a document as Markdown.
 *
 * Google added `text/markdown` as a native export format in July 2024, so headings, lists,
 * tables and links round-trip without us reimplementing a serializer. Used for whole-document
 * reads where the agent wants prose rather than addressable structure.
 *
 * Note the 10 MB export ceiling — very large documents fall back to the AST renderer.
 */
export async function exportMarkdown(documentId: string): Promise<string> {
  const { drive } = await getGoogleClients();

  return withRetry(
    async () => {
      const response = await drive.files.export(
        { fileId: documentId, mimeType: "text/markdown" },
        { responseType: "text" },
      );
      // The typed signature says `unknown` because the payload depends on the requested MIME
      // type; for a text response type googleapis hands back the body verbatim.
      return response.data as unknown as string;
    },
    `Could not export document ${documentId} as Markdown`,
  );
}

/** Formats a Google Doc can be exported to, with the extension each one implies. */
export const EXPORT_FORMATS = {
  pdf: { mimeType: "application/pdf", extension: "pdf" },
  docx: {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
  },
  odt: { mimeType: "application/vnd.oasis.opendocument.text", extension: "odt" },
  rtf: { mimeType: "application/rtf", extension: "rtf" },
  txt: { mimeType: "text/plain", extension: "txt" },
  html: { mimeType: "text/html", extension: "html" },
  epub: { mimeType: "application/epub+zip", extension: "epub" },
  markdown: { mimeType: "text/markdown", extension: "md" },
} as const;

export type ExportFormat = keyof typeof EXPORT_FORMATS;

/**
 * Export a document to bytes in the requested format.
 *
 * Binary-safe: the response is requested as an arraybuffer rather than text, because a PDF or
 * .docx run through a string round trip is silently corrupted — the damage only shows when someone
 * tries to open the file.
 *
 * Google caps exports at 10 MB.
 */
export async function exportDocument(documentId: string, format: ExportFormat): Promise<Buffer> {
  const { drive } = await getGoogleClients();
  const { mimeType } = EXPORT_FORMATS[format];

  return withRetry(
    async () => {
      const response = await drive.files.export(
        { fileId: documentId, mimeType },
        { responseType: "arraybuffer" },
      );
      return Buffer.from(response.data as unknown as ArrayBuffer);
    },
    `Could not export document ${documentId} as ${format}`,
  );
}

/** Look up a single document's metadata. */
export async function getDocumentMetadata(documentId: string): Promise<DocumentSummary> {
  const { drive } = await getGoogleClients();

  return withRetry(
    async () => {
      const response = await drive.files.get({
        fileId: documentId,
        fields: "id,name,modifiedTime,owners(emailAddress),webViewLink",
      });
      const file = response.data;
      return {
        id: file.id ?? documentId,
        name: file.name ?? "(untitled)",
        modifiedTime: file.modifiedTime ?? undefined,
        owners: (file.owners ?? []).map((o) => o.emailAddress ?? "").filter(Boolean),
        webViewLink: file.webViewLink ?? undefined,
      };
    },
    `Could not read metadata for document ${documentId}`,
  );
}

/**
 * Find documents by name.
 *
 * Restricted to Google Docs files and to non-trashed items, because an agent asked to "open the
 * thesis draft" should never be handed a PDF or a deleted copy.
 */
export async function findDocuments(
  query: string | undefined,
  limit = 20,
): Promise<DocumentSummary[]> {
  const { drive } = await getGoogleClients();

  const clauses = [`mimeType='${DOC_MIME}'`, "trashed=false"];
  if (query) {
    // Escaping single quotes keeps a title containing an apostrophe from breaking the query.
    clauses.push(`name contains '${query.replace(/'/g, "\\'")}'`);
  }

  return withRetry(
    async () => {
      const response = await drive.files.list({
        q: clauses.join(" and "),
        pageSize: Math.min(limit, 100),
        orderBy: "modifiedTime desc",
        fields: "files(id,name,modifiedTime,owners(emailAddress),webViewLink)",
      });
      return (response.data.files ?? []).map((file) => ({
        id: file.id ?? "",
        name: file.name ?? "(untitled)",
        modifiedTime: file.modifiedTime ?? undefined,
        owners: (file.owners ?? []).map((o) => o.emailAddress ?? "").filter(Boolean),
        webViewLink: file.webViewLink ?? undefined,
      }));
    },
    query ? `Could not search for documents matching "${query}"` : "Could not list documents",
  );
}

/** MIME types Drive can convert into a native Google Doc. */
const CONVERTIBLE_TO_DOC = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/msword", // .doc
  "application/rtf",
  "text/rtf",
  "text/plain",
  "text/markdown",
  "text/html",
  "application/vnd.oasis.opendocument.text", // .odt
]);

export interface ConversionResult {
  documentId: string;
  name: string;
  webViewLink: string | undefined;
  /** MIME type of the source file, for reporting. */
  sourceMimeType: string;
}

/**
 * Convert an uploaded file into a native Google Doc.
 *
 * Implemented as a *copy* rather than an in-place conversion, because Drive offers no in-place
 * option and because destroying someone's original during a format change would be an
 * unreasonable thing for a tool to do on its own. The source is left exactly as it was.
 *
 * This is the only route by which the rest of this server can touch a `.docx`: the Docs API
 * refuses Office files outright, so without conversion there is nothing to address, read or edit.
 */
export async function convertToGoogleDoc(
  fileId: string,
  newName?: string,
): Promise<ConversionResult> {
  const { drive } = await getGoogleClients();

  return withRetry(
    async () => {
      const source = await drive.files.get({ fileId, fields: "name,mimeType" });
      const sourceMimeType = source.data.mimeType ?? "unknown";

      if (sourceMimeType === DOC_MIME) {
        throw new Error("That file is already a native Google Doc; no conversion is needed.");
      }
      if (!CONVERTIBLE_TO_DOC.has(sourceMimeType)) {
        throw new Error(
          `Drive cannot convert "${sourceMimeType}" into a Google Doc. ` +
            `Convertible formats are .docx, .doc, .odt, .rtf, .txt, .md and .html.`,
        );
      }

      const baseName = source.data.name ?? "document";
      const stripped = baseName.replace(/\.(docx?|odt|rtf|txt|md|html?)$/i, "");

      const copy = await drive.files.copy({
        fileId,
        // Naming the target MIME type is what makes Drive convert rather than duplicate.
        requestBody: { name: newName ?? `${stripped} (Google Docs)`, mimeType: DOC_MIME },
        fields: "id,name,webViewLink",
      });

      const documentId = copy.data.id;
      if (!documentId) throw new Error("Drive converted the file but returned no id.");

      return {
        documentId,
        name: copy.data.name ?? stripped,
        webViewLink: copy.data.webViewLink ?? undefined,
        sourceMimeType,
      };
    },
    `Could not convert file ${fileId} to a Google Doc`,
  );
}

/* -------------------------------------------------------------------------- */
/* Asset hosting                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Upload bytes to Drive and return the new file's id.
 *
 * Files are created in the Drive root with a recognizable name, because the alternative — a file
 * with an opaque name appearing in someone's Drive with no explanation — is worse than a
 * momentary bit of clutter. The image pipeline deletes them again once the image is embedded.
 */
export async function uploadFile(
  name: string,
  mimeType: string,
  body: Buffer,
): Promise<string> {
  const { drive } = await getGoogleClients();

  return withRetry(
    async () => {
      const response = await drive.files.create({
        requestBody: { name, mimeType },
        media: { mimeType, body: Readable.from(body) },
        fields: "id",
      });
      const id = response.data.id;
      if (!id) throw new Error("Drive accepted the upload but returned no file id.");
      return id;
    },
    `Could not upload "${name}" to Drive`,
  );
}

/**
 * Grant read access to anyone with the link, returning the permission id.
 *
 * This exists solely to let Google's own Docs servers fetch an image: `insertInlineImage` makes
 * a server-side request with no credentials attached, so a private file is invisible to it no
 * matter what the caller is authorized to do. The grant is meant to be revoked seconds later by
 * the caller's `finally` block.
 */
export async function grantLinkAccess(fileId: string): Promise<string> {
  const { drive } = await getGoogleClients();

  return withRetry(
    async () => {
      const response = await drive.permissions.create({
        fileId,
        requestBody: { role: "reader", type: "anyone" },
        fields: "id",
      });
      const id = response.data.id;
      if (!id) throw new Error("Drive granted access but returned no permission id.");
      return id;
    },
    `Could not share file ${fileId}`,
  );
}

/** Revoke a permission. Never throws — used from cleanup paths that must not mask a real error. */
export async function revokeAccess(fileId: string, permissionId: string): Promise<boolean> {
  try {
    const { drive } = await getGoogleClients();
    await drive.permissions.delete({ fileId, permissionId });
    return true;
  } catch {
    return false;
  }
}

/** Delete a file. Never throws, for the same reason as `revokeAccess`. */
export async function deleteFile(fileId: string): Promise<boolean> {
  try {
    const { drive } = await getGoogleClients();
    await drive.files.delete({ fileId });
    return true;
  } catch {
    return false;
  }
}

/** Fetch a Drive file's bytes, used to validate an image that already lives in Drive. */
export async function downloadFile(fileId: string): Promise<Buffer> {
  const { drive } = await getGoogleClients();

  return withRetry(
    async () => {
      const response = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" },
      );
      return Buffer.from(response.data as unknown as ArrayBuffer);
    },
    `Could not download file ${fileId}`,
  );
}

export interface RevisionSummary {
  id: string;
  modifiedTime: string | undefined;
  lastModifyingUser: string | undefined;
}

/**
 * List stored revisions.
 *
 * This is the restore path that justifies defaulting to direct writes: every mutation records
 * the revision it started from, and that revision is retrievable here.
 */
export async function listRevisions(documentId: string, limit = 20): Promise<RevisionSummary[]> {
  const { drive } = await getGoogleClients();

  return withRetry(
    async () => {
      const response = await drive.revisions.list({
        fileId: documentId,
        pageSize: Math.min(limit, 1000),
        fields: "revisions(id,modifiedTime,lastModifyingUser(displayName))",
      });
      return (response.data.revisions ?? []).map((revision) => ({
        id: revision.id ?? "",
        modifiedTime: revision.modifiedTime ?? undefined,
        lastModifyingUser: revision.lastModifyingUser?.displayName ?? undefined,
      }));
    },
    `Could not list revisions for document ${documentId}`,
  );
}
