import { getGoogleClients } from "./clients.js";
import { withRetry } from "./retry.js";

/**
 * Comments, via the Drive API.
 *
 * Drive is used rather than the Docs API's newer comment requests because Drive's comment
 * endpoints are generally available while the Docs ones require Developer Preview enrollment.
 * The trade-off is anchoring: Drive accepts an `anchor` field and stores it faithfully, but the
 * Docs editor **ignores it** and renders every API-created comment as document-level. So a
 * comment written here is real and visible, it simply does not highlight a span of text.
 *
 * `capabilities.ts` detects whether the preview path is available and prefers it when it is.
 */

export interface CommentReply {
  id: string;
  author: string;
  content: string;
  createdTime: string | undefined;
  /** "resolve" or "reopen" when the reply also changed the thread's state. */
  action: string | undefined;
}

export interface DocumentComment {
  id: string;
  author: string;
  content: string;
  createdTime: string | undefined;
  modifiedTime: string | undefined;
  resolved: boolean;
  /** The document text this comment refers to, when Drive recorded it. */
  quotedText: string | undefined;
  replies: CommentReply[];
}

/**
 * Field mask for comment reads.
 *
 * Drive's comment endpoints reject a request that omits `fields` entirely rather than defaulting,
 * so this is required rather than an optimization.
 */
const COMMENT_FIELDS =
  "comments(id,author(displayName),content,createdTime,modifiedTime,resolved," +
  "quotedFileContent(value),replies(id,author(displayName),content,createdTime,action))";

const SINGLE_COMMENT_FIELDS = COMMENT_FIELDS.replace(/^comments\(/, "").replace(/\)$/, "");

interface RawComment {
  id?: string | null;
  author?: { displayName?: string | null } | null;
  content?: string | null;
  createdTime?: string | null;
  modifiedTime?: string | null;
  resolved?: boolean | null;
  quotedFileContent?: { value?: string | null } | null;
  replies?: {
    id?: string | null;
    author?: { displayName?: string | null } | null;
    content?: string | null;
    createdTime?: string | null;
    action?: string | null;
  }[] | null;
}

function toComment(raw: RawComment): DocumentComment {
  return {
    id: raw.id ?? "",
    author: raw.author?.displayName ?? "unknown",
    content: raw.content ?? "",
    createdTime: raw.createdTime ?? undefined,
    modifiedTime: raw.modifiedTime ?? undefined,
    resolved: Boolean(raw.resolved),
    quotedText: raw.quotedFileContent?.value ?? undefined,
    replies: (raw.replies ?? []).map((reply) => ({
      id: reply.id ?? "",
      author: reply.author?.displayName ?? "unknown",
      content: reply.content ?? "",
      createdTime: reply.createdTime ?? undefined,
      action: reply.action ?? undefined,
    })),
  };
}

/** List a document's comment threads. */
export async function listComments(
  documentId: string,
  options: { includeResolved?: boolean; limit?: number } = {},
): Promise<DocumentComment[]> {
  const { drive } = await getGoogleClients();
  const { includeResolved = false, limit = 100 } = options;

  return withRetry(
    async () => {
      const response = await drive.comments.list({
        fileId: documentId,
        fields: COMMENT_FIELDS,
        pageSize: Math.min(limit, 100),
        // Without this Drive omits the resolved ones entirely, and "no open comments" would be
        // indistinguishable from "no comments at all".
        includeDeleted: false,
      });

      const comments = (response.data.comments ?? []).map(toComment);
      return includeResolved ? comments : comments.filter((c) => !c.resolved);
    },
    `Could not list comments on document ${documentId}`,
  );
}

/** Create a document-level comment. */
export async function createComment(documentId: string, content: string): Promise<DocumentComment> {
  const { drive } = await getGoogleClients();

  return withRetry(
    async () => {
      const response = await drive.comments.create({
        fileId: documentId,
        fields: SINGLE_COMMENT_FIELDS,
        requestBody: { content },
      });
      return toComment(response.data as RawComment);
    },
    `Could not comment on document ${documentId}`,
  );
}

/**
 * Reply to a comment, optionally resolving or reopening the thread.
 *
 * Drive models resolution as a property of a *reply* rather than an operation on the thread, so
 * resolving always leaves a visible reply behind. Passing content alongside the action is
 * therefore worth doing — an empty resolution reads as a thread that closed itself.
 */
export async function replyToComment(
  documentId: string,
  commentId: string,
  content: string,
  action?: "resolve" | "reopen",
): Promise<CommentReply> {
  const { drive } = await getGoogleClients();

  return withRetry(
    async () => {
      const response = await drive.replies.create({
        fileId: documentId,
        commentId,
        fields: "id,author(displayName),content,createdTime,action",
        requestBody: { content, ...(action ? { action } : {}) },
      });
      const reply = response.data;
      return {
        id: reply.id ?? "",
        author: reply.author?.displayName ?? "unknown",
        content: reply.content ?? "",
        createdTime: reply.createdTime ?? undefined,
        action: reply.action ?? undefined,
      };
    },
    `Could not reply to comment ${commentId}`,
  );
}
