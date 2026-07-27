import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exportMarkdown, findDocuments, getDocumentMetadata, listRevisions } from "../google/drive.js";
import { createDocument } from "../google/docs.js";
import { loadDocument } from "../core/document.js";
import { renderMarkdown, renderOutline } from "../core/markdown/render.js";
import { findTextMatches, resolveAddress } from "../core/address/resolve.js";
import { mutate, type MutationOutcome } from "../core/mutate/executor.js";
import {
  deleteBlock,
  deleteRange,
  formatRange,
  insertAt,
  insertParagraphAfter,
  insertParagraphBefore,
  insertTable,
  makeList,
  replaceRange,
  setParagraphStyle,
} from "../core/mutate/intents.js";
import { addressFields, buildAddress, type AddressArgs } from "./address-input.js";
import { guard, textResult } from "./errors.js";

/**
 * The agent-facing tool surface.
 *
 * Not one index appears anywhere in these schemas. That is the entire point: an agent describes
 * *what* it wants changed and the server works out *where* that is, against a document it re-reads
 * at the moment of writing.
 */

export function parseDocumentId(input: string): string {
  const trimmed = input.trim();
  const match = /\/document\/d\/([a-zA-Z0-9_-]+)/.exec(trimmed);
  if (match?.[1]) return match[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  throw new Error(
    `"${input}" is not a Google Docs document ID or URL. ` +
      `Expected an ID like 1a2B3c… or a URL like https://docs.google.com/document/d/1a2B3c…/edit`,
  );
}

const documentField = z.string().describe("Document ID or Google Docs URL");
const modeField = z
  .enum(["direct", "suggest"])
  .default("direct")
  .describe(
    "'direct' commits the edit immediately. 'suggest' writes it as a tracked suggestion the " +
      "user can accept or reject, which needs Developer Preview access.",
  );

/** Describe what an applied mutation did, including the restore point. */
function describeOutcome(outcome: MutationOutcome, summary: string): string {
  const lines = [summary];
  if (outcome.attempts > 1) {
    lines.push(
      `Applied on attempt ${outcome.attempts} — someone else was editing at the same time, ` +
        `so the edit was recomputed against their changes.`,
    );
  }
  lines.push(`Revision before: ${outcome.fromRevisionId}`);
  return lines.join("\n");
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "gdocs-native", version: "0.1.0" });

  /* ---------------------------------------------------------------------- */
  /* Discovery                                                               */
  /* ---------------------------------------------------------------------- */

  server.registerTool(
    "doc_list",
    {
      title: "List Google Docs",
      description:
        "Find the user's Google Docs by name, most recently modified first. Use this to turn a " +
        "document the user named into the ID the other tools need.",
      inputSchema: {
        query: z.string().optional().describe("Filter by words in the title"),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    guard(async ({ query, limit }) => {
      const documents = await findDocuments(query, limit);
      if (documents.length === 0) {
        return textResult(query ? `No documents match "${query}".` : "No documents found.");
      }
      return textResult(
        documents
          .map((d) => `- ${d.name}\n  id: ${d.id}\n  modified: ${d.modifiedTime ?? "unknown"}`)
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "doc_create",
    {
      title: "Create a Google Doc",
      description: "Create a new empty Google Doc and return its ID and URL.",
      inputSchema: { title: z.string().min(1).describe("Title for the new document") },
    },
    guard(async ({ title }) => {
      const id = await createDocument(title);
      return textResult(
        `Created "${title}".\nid: ${id}\nurl: https://docs.google.com/document/d/${id}/edit`,
      );
    }),
  );

  /* ---------------------------------------------------------------------- */
  /* Reading                                                                 */
  /* ---------------------------------------------------------------------- */

  server.registerTool(
    "doc_read",
    {
      title: "Read a Google Doc",
      description:
        "Read a document as Markdown. Use format 'addressed' before editing: it prefixes every " +
        "block with a {#handle} that the editing tools accept and that stays valid even if " +
        "someone else edits the document meanwhile. Use 'clean' when only the prose matters.",
      inputSchema: {
        document: documentField,
        format: z
          .enum(["clean", "addressed"])
          .default("clean")
          .describe("'clean' for reading, 'addressed' for editing"),
        include_headers_footers: z.boolean().default(false),
        tab_id: z.string().optional().describe("Restrict to one tab"),
      },
    },
    guard(async ({ document, format, include_headers_footers, tab_id }) => {
      const documentId = parseDocumentId(document);

      if (format === "clean" && !include_headers_footers && !tab_id) {
        // Google's own exporter has the highest fidelity for plain reading, and costs one call.
        const [markdown, meta] = await Promise.all([
          exportMarkdown(documentId),
          getDocumentMetadata(documentId),
        ]);
        return textResult(`# ${meta.name}\n\n${markdown}`);
      }

      const parsed = await loadDocument(documentId);
      const body = renderMarkdown(parsed, {
        mode: format,
        includeSegments: include_headers_footers,
        ...(tab_id ? { tabId: tab_id } : {}),
      });
      return textResult(`# ${parsed.title}\n\n${body}`);
    }),
  );

  server.registerTool(
    "doc_outline",
    {
      title: "Outline a Google Doc",
      description:
        "List a document's headings with their block handles. The cheapest way to orient in a " +
        "long document before deciding what to read or edit.",
      inputSchema: { document: documentField },
    },
    guard(async ({ document }) => {
      const parsed = await loadDocument(parseDocumentId(document));
      return textResult(`# ${parsed.title}\n\n${renderOutline(parsed)}`);
    }),
  );

  server.registerTool(
    "doc_search",
    {
      title: "Search inside a Google Doc",
      description:
        "Find every occurrence of a phrase in a document and return each with its block handle " +
        "and surrounding context. Use this to check how many matches exist before replacing.",
      inputSchema: {
        document: documentField,
        query: z.string().min(1).describe("Text to find"),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    guard(async ({ document, query, limit }) => {
      const parsed = await loadDocument(parseDocumentId(document));
      const matches = findTextMatches(parsed, query);
      if (matches.length === 0) return textResult(`No matches for "${query}".`);

      const lines = matches.slice(0, limit).map((m, i) => {
        const context = m.block.text.length > 160 ? `${m.block.text.slice(0, 159)}…` : m.block.text;
        return `${i + 1}. {#${m.block.id}} (${m.block.kind})\n   ${context}`;
      });
      const more = matches.length > limit ? `\n\n(${matches.length - limit} more)` : "";
      return textResult(`${matches.length} match(es) for "${query}":\n\n${lines.join("\n")}${more}`);
    }),
  );

  server.registerTool(
    "doc_history",
    {
      title: "List document revisions",
      description: "List stored revisions of a document with who last modified each.",
      inputSchema: {
        document: documentField,
        limit: z.number().int().min(1).max(200).default(20),
      },
    },
    guard(async ({ document, limit }) => {
      const revisions = await listRevisions(parseDocumentId(document), limit);
      if (revisions.length === 0) return textResult("No stored revisions.");
      return textResult(
        revisions
          .slice()
          .reverse()
          .map((r) => `- ${r.modifiedTime ?? "unknown"} by ${r.lastModifyingUser ?? "unknown"} (id ${r.id})`)
          .join("\n"),
      );
    }),
  );

  /* ---------------------------------------------------------------------- */
  /* Editing                                                                 */
  /* ---------------------------------------------------------------------- */

  server.registerTool(
    "doc_replace",
    {
      title: "Replace text in a Google Doc",
      description:
        "Replace a block's text, or a phrase within it, with new text. Target it with a block " +
        "handle, or with 'find' to match text directly. If 'find' matches several places you " +
        "will be told how many and asked to pick one — nothing is changed until it is unambiguous.",
      inputSchema: {
        document: documentField,
        ...addressFields,
        replacement: z.string().describe("The new text"),
        whole_block: z
          .boolean()
          .default(false)
          .describe(
            "When targeting with 'find', replace the entire block containing the match rather " +
              "than just the matched phrase.",
          ),
        mode: modeField,
      },
    },
    guard(async (args) => {
      const { document, replacement, whole_block, mode, ...rest } = args;
      const documentId = parseDocumentId(document);
      const address = buildAddress(rest as AddressArgs);

      let targetLabel = "";
      const outcome = await mutate(
        documentId,
        (doc) => {
          const found = resolveAddress(doc, address);
          const range = whole_block && found.block ? found.block.textRange : found.range;
          targetLabel = found.block ? `{#${found.block.id}}` : "the target range";
          return replaceRange(range, replacement);
        },
        { mode, description: `replace in ${documentId}` },
      );

      return textResult(describeOutcome(outcome, `Replaced text in ${targetLabel}.`));
    }),
  );

  server.registerTool(
    "doc_insert",
    {
      title: "Insert text into a Google Doc",
      description:
        "Insert a new paragraph at the start or end of a document, or immediately before or " +
        "after a block you identify. Inserting 'after' a heading creates a normal paragraph " +
        "rather than another heading.",
      inputSchema: {
        document: documentField,
        text: z.string().min(1).describe("Text of the new paragraph"),
        position: z
          .enum(["end", "start", "after", "before"])
          .default("end")
          .describe("Where to insert. 'after' and 'before' need a target as well."),
        ...addressFields,
        mode: modeField,
      },
    },
    guard(async (args) => {
      const { document, text, position, mode, ...rest } = args;
      const documentId = parseDocumentId(document);
      const addressArgs = rest as AddressArgs;
      const needsTarget = position === "after" || position === "before";
      const address = needsTarget ? buildAddress(addressArgs) : undefined;

      const outcome = await mutate(
        documentId,
        (doc) => {
          if (!address) {
            const anchor = resolveAddress(doc, { kind: "position", at: position === "start" ? "start" : "end" });
            return insertAt(anchor.range, position === "start" ? `${text}\n` : `\n${text}`);
          }
          const found = resolveAddress(doc, address);
          if (!found.block) {
            return insertAt(found.range, `\n${text}`);
          }
          return position === "after"
            ? insertParagraphAfter(found.block, text)
            : insertParagraphBefore(found.block, text);
        },
        { mode, description: `insert into ${documentId}` },
      );

      return textResult(describeOutcome(outcome, `Inserted a paragraph (${position}).`));
    }),
  );

  server.registerTool(
    "doc_delete",
    {
      title: "Delete content from a Google Doc",
      description:
        "Delete an entire block, or just a matched phrase within it. Deleting a block removes " +
        "its paragraph entirely rather than leaving a blank line.",
      inputSchema: {
        document: documentField,
        ...addressFields,
        whole_block: z
          .boolean()
          .default(true)
          .describe("Remove the entire block. Set false to delete only the matched phrase."),
        mode: modeField,
      },
    },
    guard(async (args) => {
      const { document, whole_block, mode, ...rest } = args;
      const documentId = parseDocumentId(document);
      const address = buildAddress(rest as AddressArgs);

      let summary = "";
      const outcome = await mutate(
        documentId,
        (doc) => {
          const found = resolveAddress(doc, address);
          if (whole_block && found.block) {
            summary = `Deleted block {#${found.block.id}} ("${found.block.text.slice(0, 60)}").`;
            return deleteBlock(found.block);
          }
          summary = "Deleted the matched text.";
          return deleteRange(found.range);
        },
        { mode, description: `delete from ${documentId}` },
      );

      return textResult(describeOutcome(outcome, summary));
    }),
  );

  server.registerTool(
    "doc_format",
    {
      title: "Format text in a Google Doc",
      description:
        "Apply character formatting — bold, italic, underline, strikethrough, size, link — to a " +
        "block or a matched phrase. Only the properties you pass are changed; the rest are left " +
        "exactly as they were.",
      inputSchema: {
        document: documentField,
        ...addressFields,
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        underline: z.boolean().optional(),
        strikethrough: z.boolean().optional(),
        font_size: z.number().min(1).max(400).optional().describe("Point size"),
        link: z.string().optional().describe("URL to link to; empty string removes the link"),
        whole_block: z.boolean().default(false),
        mode: modeField,
      },
    },
    guard(async (args) => {
      const { document, bold, italic, underline, strikethrough, font_size, link, whole_block, mode, ...rest } =
        args;
      const documentId = parseDocumentId(document);
      const address = buildAddress(rest as AddressArgs);

      const outcome = await mutate(
        documentId,
        (doc) => {
          const found = resolveAddress(doc, address);
          const range = whole_block && found.block ? found.block.textRange : found.range;
          return formatRange(range, {
            ...(bold !== undefined ? { bold } : {}),
            ...(italic !== undefined ? { italic } : {}),
            ...(underline !== undefined ? { underline } : {}),
            ...(strikethrough !== undefined ? { strikethrough } : {}),
            ...(font_size !== undefined ? { fontSize: font_size } : {}),
            ...(link !== undefined ? { link } : {}),
          });
        },
        { mode, description: `format in ${documentId}` },
      );

      return textResult(describeOutcome(outcome, "Applied formatting."));
    }),
  );

  server.registerTool(
    "doc_style",
    {
      title: "Change a block's paragraph style",
      description:
        "Turn a block into a heading, title, or normal text, or convert blocks into a bulleted " +
        "or numbered list.",
      inputSchema: {
        document: documentField,
        ...addressFields,
        style: z
          .enum([
            "TITLE",
            "SUBTITLE",
            "HEADING_1",
            "HEADING_2",
            "HEADING_3",
            "HEADING_4",
            "HEADING_5",
            "HEADING_6",
            "NORMAL_TEXT",
            "BULLET_LIST",
            "NUMBERED_LIST",
          ])
          .describe("Target style"),
        mode: modeField,
      },
    },
    guard(async (args) => {
      const { document, style, mode, ...rest } = args;
      const documentId = parseDocumentId(document);
      const address = buildAddress(rest as AddressArgs);

      const outcome = await mutate(
        documentId,
        (doc) => {
          const found = resolveAddress(doc, address);
          if (!found.block) throw new Error("Styling needs a block target.");
          if (style === "BULLET_LIST") return makeList(found.block.range, false);
          if (style === "NUMBERED_LIST") return makeList(found.block.range, true);
          return setParagraphStyle(found.block, style);
        },
        { mode, description: `style in ${documentId}` },
      );

      return textResult(describeOutcome(outcome, `Applied style ${style}.`));
    }),
  );

  server.registerTool(
    "doc_insert_table",
    {
      title: "Insert a table into a Google Doc",
      description:
        "Insert an empty table with the given dimensions at the end of the document or after a " +
        "block. Fill it afterwards by reading the document and replacing the cells' text.",
      inputSchema: {
        document: documentField,
        rows: z.number().int().min(1).max(100),
        columns: z.number().int().min(1).max(20),
        position: z.enum(["end", "after"]).default("end"),
        ...addressFields,
        mode: modeField,
      },
    },
    guard(async (args) => {
      const { document, rows, columns, position, mode, ...rest } = args;
      const documentId = parseDocumentId(document);
      const address = position === "after" ? buildAddress(rest as AddressArgs) : undefined;

      const outcome = await mutate(
        documentId,
        (doc) => {
          if (!address) {
            const end = resolveAddress(doc, { kind: "position", at: "end" });
            return insertTable(end.range, rows, columns);
          }
          const found = resolveAddress(doc, address);
          const anchor = found.block
            ? { ...found.block.range, startIndex: found.block.range.endIndex }
            : found.range;
          return insertTable(anchor, rows, columns);
        },
        { mode, description: `insert ${rows}x${columns} table into ${documentId}` },
      );

      return textResult(
        describeOutcome(
          outcome,
          `Inserted a ${rows}x${columns} table. Read the document with format 'addressed' to get ` +
            `the cells' handles, then use doc_replace to fill them.`,
        ),
      );
    }),
  );

  return server;
}
