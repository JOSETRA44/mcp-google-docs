import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exportMarkdown, findDocuments, getDocumentMetadata, listRevisions } from "../google/drive.js";
import { createDocument } from "../google/docs.js";
import { guard, textResult } from "./errors.js";

/**
 * MCP tool surface.
 *
 * Tool descriptions are written for a reader who cannot see the document and has no notion of
 * character indices. They state what the tool operates on and what it returns, because the
 * description is the entire basis on which an agent decides between tools.
 */

/**
 * Accept either a bare document ID or a full Docs URL.
 *
 * Agents are given URLs by users far more often than bare IDs, and an agent that has to
 * string-slice a URL before every call will eventually slice it wrong. Doing it here once is
 * both more reliable and less to explain.
 */
export function parseDocumentId(input: string): string {
  const trimmed = input.trim();
  const match = /\/document\/d\/([a-zA-Z0-9_-]+)/.exec(trimmed);
  if (match?.[1]) return match[1];
  // A bare ID: Drive file IDs are URL-safe base64-ish and always longer than a few characters.
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  throw new Error(
    `"${input}" is not a Google Docs document ID or URL. ` +
      `Expected an ID like 1a2B3c… or a URL like https://docs.google.com/document/d/1a2B3c…/edit`,
  );
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "gdocs-native", version: "0.1.0" });

  server.registerTool(
    "doc_list",
    {
      title: "List Google Docs",
      description:
        "Find the user's Google Docs by name, most recently modified first. Use this to turn a " +
        "document the user referred to by title into the ID the other tools need. Omit the query " +
        "to list recent documents.",
      inputSchema: {
        query: z.string().optional().describe("Filter by words appearing in the document title"),
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum results"),
      },
    },
    guard(async ({ query, limit }) => {
      const documents = await findDocuments(query, limit);
      if (documents.length === 0) {
        return textResult(query ? `No documents match "${query}".` : "No documents found.");
      }
      const lines = documents.map(
        (doc) => `- ${doc.name}\n  id: ${doc.id}\n  modified: ${doc.modifiedTime ?? "unknown"}`,
      );
      return textResult(`${documents.length} document(s):\n\n${lines.join("\n")}`);
    }),
  );

  server.registerTool(
    "doc_read",
    {
      title: "Read a Google Doc as Markdown",
      description:
        "Return the full text of a Google Doc as Markdown, preserving headings, lists, tables and " +
        "links. Use this to read or summarize a document. Accepts a document ID or a Docs URL.",
      inputSchema: {
        document: z.string().describe("Document ID or Google Docs URL"),
      },
    },
    guard(async ({ document }) => {
      const documentId = parseDocumentId(document);
      const [markdown, meta] = await Promise.all([
        exportMarkdown(documentId),
        getDocumentMetadata(documentId),
      ]);
      return textResult(`# ${meta.name}\n\n${markdown}`);
    }),
  );

  server.registerTool(
    "doc_create",
    {
      title: "Create a Google Doc",
      description:
        "Create a new, empty Google Doc owned by the signed-in user and return its ID and URL.",
      inputSchema: {
        title: z.string().min(1).describe("Title for the new document"),
      },
    },
    guard(async ({ title }) => {
      const documentId = await createDocument(title);
      return textResult(
        `Created "${title}".\nid: ${documentId}\nurl: https://docs.google.com/document/d/${documentId}/edit`,
      );
    }),
  );

  server.registerTool(
    "doc_history",
    {
      title: "List document revisions",
      description:
        "List stored revisions of a document, newest first, with who last modified each. Use this " +
        "to see how a document changed over time or to identify a point to restore to.",
      inputSchema: {
        document: z.string().describe("Document ID or Google Docs URL"),
        limit: z.number().int().min(1).max(200).default(20).describe("Maximum revisions"),
      },
    },
    guard(async ({ document, limit }) => {
      const documentId = parseDocumentId(document);
      const revisions = await listRevisions(documentId, limit);
      if (revisions.length === 0) return textResult("No stored revisions for this document.");
      const lines = revisions
        .slice()
        .reverse()
        .map((r) => `- ${r.modifiedTime ?? "unknown"}  by ${r.lastModifyingUser ?? "unknown"}  (id ${r.id})`);
      return textResult(`${revisions.length} revision(s), newest first:\n\n${lines.join("\n")}`);
    }),
  );

  return server;
}
