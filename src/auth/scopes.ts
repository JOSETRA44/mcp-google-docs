/**
 * OAuth scopes.
 *
 * These are deliberately the narrowest set that still supports the full capability surface. The
 * combination matters: `documents` alone cannot insert an image, because `insertInlineImage`
 * makes Google fetch the image URI from its own servers with no auth context — so the image must
 * first be uploaded to Drive and briefly shared. That upload needs `drive.file`.
 */

/** Read and write document content. */
export const DOCUMENTS = "https://www.googleapis.com/auth/documents";

/**
 * Create files and manage only the files this app created or the user explicitly opened with it.
 * Notably this is what allows the temporary image-hosting step of the image pipeline without
 * requesting blanket Drive write access.
 */
export const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

/**
 * Read-only access to Drive metadata and content. Needed to open documents the user did not
 * create through this app, to export to markdown, and to read comments and revisions.
 */
export const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";

/**
 * Full scope set requested at login. Matches the four scopes Google documents for its own Docs
 * MCP server, which keeps this server usable against the same OAuth client.
 */
export const ALL_SCOPES: readonly string[] = [
  DOCUMENTS,
  "https://www.googleapis.com/auth/documents.readonly",
  DRIVE_FILE,
  DRIVE_READONLY,
];

/** Scopes required for a given capability, used to produce actionable errors on 403. */
export const SCOPE_REQUIREMENTS = {
  readDocument: [DRIVE_READONLY],
  writeDocument: [DOCUMENTS],
  exportMarkdown: [DRIVE_READONLY],
  uploadAsset: [DRIVE_FILE],
  readComments: [DRIVE_READONLY],
  writeComments: [DRIVE_FILE],
} as const satisfies Record<string, readonly string[]>;
