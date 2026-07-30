import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exportMarkdown, findDocuments, getDocumentMetadata, listRevisions } from "../google/drive.js";
import { createDocument } from "../google/docs.js";
import { loadDocument } from "../core/document.js";
import { renderMarkdown, renderOutline } from "../core/markdown/render.js";
import { findTextMatches, resolveAddress, type Address } from "../core/address/resolve.js";
import { createComment, listComments, replyToComment } from "../google/comments.js";
import { convertToGoogleDoc } from "../google/drive.js";
import { insertDocumentImage, type ImageSource } from "../core/assets/images.js";
import { writeMarkdown } from "../core/markdown/write.js";
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

  server.registerTool(
    "doc_convert",
    {
      title: "Convert an uploaded file to a Google Doc",
      description:
        "Convert a .docx, .doc, .odt, .rtf, .txt, .md or .html file in Drive into a native " +
        "Google Doc, and return the new document's ID. Use this when another tool reports that " +
        "a file is an Office document — the Docs API cannot read or edit those. The original " +
        "file is left untouched; this creates a converted copy.",
      inputSchema: {
        file: z.string().describe("Drive file ID or URL of the file to convert"),
        name: z.string().optional().describe("Name for the converted document"),
      },
    },
    guard(async ({ file, name }) => {
      const fileId = parseDocumentId(file);
      const result = await convertToGoogleDoc(fileId, name);
      return textResult(
        `Converted "${result.name}" from ${result.sourceMimeType} to a Google Doc.\n` +
          `id: ${result.documentId}\n` +
          `url: https://docs.google.com/document/d/${result.documentId}/edit\n` +
          `The original file was not modified.`,
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
        match_style: z
          .boolean()
          .default(false)
          .describe(
            "Keep the neighbouring paragraph's formatting instead of inserting plain body text. " +
              "Use this when extending a run of similarly formatted paragraphs — another entry " +
              "in a reference list, another line of an address — so the new one does not stand out.",
          ),
        mode: modeField,
      },
    },
    guard(async (args) => {
      const { document, text, position, match_style, mode, ...rest } = args;
      const documentId = parseDocumentId(document);
      const addressArgs = rest as AddressArgs;
      const needsTarget = position === "after" || position === "before";
      const address = needsTarget ? buildAddress(addressArgs) : undefined;

      const outcome = await mutate(
        documentId,
        (doc) => {
          const found = resolveAddress(
            doc,
            address ?? { kind: "position", at: position === "start" ? "start" : "end" },
          );

          // Only a document with no blocks at all has nowhere to anchor against; everywhere else
          // the neighbouring block is what lets the new paragraph shed the style it would
          // otherwise inherit.
          if (!found.block) return insertAt(found.range, text);

          const before = position === "start" || position === "before";
          const opts = { inheritStyle: match_style };
          return before
            ? insertParagraphBefore(found.block, text, opts)
            : insertParagraphAfter(found.block, text, opts);
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
    "doc_write_markdown",
    {
      title: "Write Markdown into a Google Doc",
      description:
        "Insert a formatted section written in Markdown — headings, bold and italic, links, " +
        "bulleted and numbered lists, tables, code, blockquotes and rules — and have it become " +
        "real Google Docs formatting rather than literal asterisks. This is the tool for adding " +
        "substantial structured content; use doc_insert for a single plain paragraph.",
      inputSchema: {
        document: documentField,
        markdown: z.string().min(1).describe("The Markdown to write"),
        position: z
          .enum(["end", "start", "after"])
          .default("end")
          .describe("Where to write it. 'after' needs a target as well."),
        ...addressFields,
        mode: modeField,
      },
    },
    guard(async (args) => {
      const { document, markdown, position, mode, ...rest } = args;
      const documentId = parseDocumentId(document);

      const target: Address =
        position === "after"
          ? buildAddress(rest as AddressArgs)
          : { kind: "position", at: position === "start" ? "start" : "end" };

      const result = await writeMarkdown(documentId, markdown, {
        position: target,
        after: position === "after",
        mode,
      });

      const parts = [
        `Wrote ${result.insertedCharacters} characters of formatted content.`,
        ...(result.tablesCreated > 0 ? [`Created ${result.tablesCreated} table(s).`] : []),
        `Revision before: ${result.fromRevisionId}`,
      ];
      return textResult(parts.join("\n"));
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

  /* ---------------------------------------------------------------------- */
  /* Assets                                                                  */
  /* ---------------------------------------------------------------------- */

  server.registerTool(
    "doc_insert_image",
    {
      title: "Insert an image into a Google Doc",
      description:
        "Insert an image from a local file path, a public URL, or a file already in the user's " +
        "Drive. Local and private Drive images are handled automatically — they are hosted " +
        "briefly so Google can fetch them, then unshared and cleaned up. Accepts PNG, JPEG and " +
        "GIF up to 50 MB and 25 megapixels.",
      inputSchema: {
        document: documentField,
        file_path: z.string().optional().describe("Path to an image on this machine"),
        url: z.string().optional().describe("Publicly reachable image URL"),
        drive_file_id: z.string().optional().describe("ID of an image already in Drive"),
        position: z.enum(["end", "start", "after"]).default("end"),
        ...addressFields,
        width_pt: z.number().min(1).optional().describe("Display width in points"),
        height_pt: z.number().min(1).optional().describe("Display height in points"),
        mode: modeField,
      },
    },
    guard(async (args) => {
      const { document, file_path, url, drive_file_id, position, width_pt, height_pt, mode, ...rest } =
        args;
      const documentId = parseDocumentId(document);

      const sources = [
        file_path !== undefined && "file_path",
        url !== undefined && "url",
        drive_file_id !== undefined && "drive_file_id",
      ].filter(Boolean);

      if (sources.length !== 1) {
        throw new Error(
          sources.length === 0
            ? "Give the image as exactly one of file_path, url, or drive_file_id."
            : `Give only one image source, but received ${sources.join(" and ")}.`,
        );
      }

      const source: ImageSource = file_path
        ? { kind: "file", path: file_path }
        : url
          ? { kind: "url", url }
          : { kind: "drive", fileId: drive_file_id! };

      const target: Address =
        position === "after"
          ? buildAddress(rest as AddressArgs)
          : { kind: "position", at: position === "start" ? "start" : "end" };

      const result = await insertDocumentImage(documentId, source, {
        position: target,
        after: position === "after",
        mode,
        ...(width_pt !== undefined ? { widthPt: width_pt } : {}),
        ...(height_pt !== undefined ? { heightPt: height_pt } : {}),
      });

      const lines = ["Inserted the image."];
      if (result.info) {
        lines.push(`Source: ${result.info.width}x${result.info.height} ${result.info.format}.`);
      }
      if (result.usedTemporaryHosting) {
        lines.push("It was hosted temporarily in Drive and has been removed again.");
      }
      if (result.cleanupWarning) lines.push(`Warning: ${result.cleanupWarning}`);
      lines.push(`Revision before: ${result.fromRevisionId}`);
      return textResult(lines.join("\n"));
    }),
  );

  /* ---------------------------------------------------------------------- */
  /* Collaboration                                                           */
  /* ---------------------------------------------------------------------- */

  server.registerTool(
    "doc_comments_list",
    {
      title: "List comments on a Google Doc",
      description:
        "Read the comment threads on a document, including replies and the text each refers to. " +
        "Use this to see what collaborators have asked for before editing.",
      inputSchema: {
        document: documentField,
        include_resolved: z.boolean().default(false).describe("Include already-resolved threads"),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    guard(async ({ document, include_resolved, limit }) => {
      const comments = await listComments(parseDocumentId(document), {
        includeResolved: include_resolved,
        limit,
      });

      if (comments.length === 0) {
        return textResult(
          include_resolved ? "This document has no comments." : "No open comments on this document.",
        );
      }

      const rendered = comments.map((c) => {
        const head = `[${c.id}] ${c.author}${c.resolved ? " (resolved)" : ""}: ${c.content}`;
        const quoted = c.quotedText ? `\n  on: "${c.quotedText.slice(0, 100)}"` : "";
        const replies = c.replies
          .map((r) => `\n  ↳ ${r.author}${r.action ? ` (${r.action})` : ""}: ${r.content}`)
          .join("");
        return head + quoted + replies;
      });

      return textResult(`${comments.length} comment thread(s):\n\n${rendered.join("\n\n")}`);
    }),
  );

  server.registerTool(
    "doc_comment",
    {
      title: "Comment on a Google Doc",
      description:
        "Add a new comment to a document. Note that comments created through the API attach to " +
        "the document as a whole rather than highlighting a specific passage, so quote the text " +
        "being discussed in the comment itself.",
      inputSchema: {
        document: documentField,
        content: z.string().min(1).describe("The comment text"),
      },
    },
    guard(async ({ document, content }) => {
      const comment = await createComment(parseDocumentId(document), content);
      return textResult(`Added comment [${comment.id}].`);
    }),
  );

  server.registerTool(
    "doc_comment_reply",
    {
      title: "Reply to a comment on a Google Doc",
      description:
        "Reply to an existing comment thread, optionally resolving or reopening it. Get thread " +
        "IDs from doc_comments_list.",
      inputSchema: {
        document: documentField,
        comment_id: z.string().describe("Thread ID from doc_comments_list"),
        content: z.string().min(1).describe("The reply text"),
        action: z
          .enum(["resolve", "reopen"])
          .optional()
          .describe("Also close or reopen the thread"),
      },
    },
    guard(async ({ document, comment_id, content, action }) => {
      await replyToComment(parseDocumentId(document), comment_id, content, action);
      return textResult(
        action ? `Replied and marked the thread ${action}d.` : "Replied to the thread.",
      );
    }),
  );

  return server;
}
