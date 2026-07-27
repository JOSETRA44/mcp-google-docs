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
