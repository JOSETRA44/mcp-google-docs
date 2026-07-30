# gdocs-native

MCP server that gives AI agents semantic control over Google Docs — **edit by intent, not by index**.

## The problem

Google's Docs API addresses documents by absolute integer indices. Every insertion or deletion
shifts every index after it, and any concurrent human edit invalidates an agent's arithmetic
silently — producing writes that land in the wrong place.

This server never exposes an index. An agent says *what* it wants changed; the server works out
*where* that is, against a document it re-reads at the moment of writing.

## How it stays correct

**Content-addressed blocks.** Every block gets a handle derived from a hash of its text, like
`{#a3f1}`. An index is a coordinate that stops being true when anything before it changes; a
content hash is an identity that survives the block moving anywhere in the document.

**Server-side operational transformation.** Every write declares the revision it was computed
against via `writeControl.targetRevisionId`. Google transforms the batch against whatever
collaborators committed in the meantime — the same engine that powers the web editor. Not a lock,
not last-write-wins.

**Just-In-Time resolution.** Indices are never cached. Every mutation re-reads, re-resolves, plans,
orders requests by descending index, and writes. A revision conflict re-plans from scratch rather
than replaying stale requests.

**Ambiguity is an error, never a guess.** If "replace the paragraph about deadlines" matches three
paragraphs, you get the three candidates back, not a confidently wrong edit.

## Setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable
   **both** the **Google Docs API** and the **Google Drive API**. Drive alone is enough to sign in
   and list files, so a project missing the Docs API passes login and then fails on the first
   edit — `doctor` checks for this specifically.
2. Under *APIs & Services → Credentials*, create an **OAuth client ID** of type **Desktop app**.
   Desktop clients permit loopback redirects on any port, which is what the CLI uses.
3. Save the downloaded JSON to `~/.gdocs-native/credentials.json` (or set
   `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`).

```bash
npm install && npm run build
node dist/index.js auth      # opens a browser, stores tokens
node dist/index.js doctor    # verifies credentials, scopes and connectivity
node dist/index.js ls        # lists your documents
```

### Register with an MCP client

```json
{
  "mcpServers": {
    "gdocs-native": {
      "command": "node",
      "args": ["C:/path/to/mcp-google-docs/dist/index.js", "mcp"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `doc_list` / `doc_create` | Find or create documents |
| `doc_read` | Read as Markdown — `clean` for prose, `addressed` for editing |
| `doc_outline` | Headings with handles; cheapest way to orient in a long document |
| `doc_search` | Every occurrence of a phrase, with handles and context |
| `doc_history` | Stored revisions and who made them |
| `doc_replace` | Replace a block's text or a phrase within it |
| `doc_insert` | Insert a paragraph at start/end, or before/after a block |
| `doc_delete` | Delete a block or a matched phrase |
| `doc_format` | Bold, italic, underline, strikethrough, size, link |
| `doc_style` | Headings, title, normal text, bulleted/numbered lists |
| `doc_write_markdown` | Write a formatted section from Markdown — headings, lists, tables, links, code |
| `doc_insert_table` | Insert an empty table |
| `doc_insert_image` | Insert an image from disk, a URL, or Drive |
| `doc_comments_list` / `doc_comment` / `doc_comment_reply` | Read and take part in comment threads |

Every write tool takes `mode: "direct" | "suggest"` (default `direct`) and reports the revision it
started from, so any edit is traceable to a restore point in Drive's version history.

Targets are given as **one** of `block_id`, `find`, `heading`, or `anchor`.

## Architecture

```
src/
  auth/         OAuth2 loopback + PKCE, token persistence
  google/       Docs & Drive clients, error classification, backoff
  core/
    ast/        document walk, segments, text normalization
    address/    content-derived ids, exact and fuzzy resolution
    markdown/   AST → addressed Markdown
    mutate/     intent → requests, descending order, OT executor
  mcp/          server and tool definitions
```

### Design notes

Two invariants are enforced centrally because getting them wrong corrupts documents silently:

- **`suggestionsViewMode` is always `SUGGESTIONS_INLINE`.** It is the only read mode whose indices
  are valid for `batchUpdate`; every other mode returns indices computed against a preview.
- **`includeTabsContent` is always true.** Without it Google returns only the first tab, and edits
  built from that read silently target tab one.

Within a block, **one character of text equals one document index**. Non-text elements — images,
page breaks, footnote references, person chips — each contribute exactly as many placeholder
characters as they occupy indices. That keeps offset-to-index conversion a plain addition
everywhere, with no offset table to keep in sync.

### Images

`insertInlineImage` makes Google's servers fetch a URI **with no authentication context at all**.
A file on your disk, or a private file in your own Drive, is therefore invisible to the very API
meant to insert it — regardless of the scopes you granted.

`doc_insert_image` handles this: it uploads the bytes, grants link access, inserts, then revokes
and deletes. The exposure lasts seconds, is bounded by cleanup that runs even when the insert
fails, and targets an unguessable 33-character file id that is never listed or indexed. Google
copies the image into the document at insert time, so the hosted original is disposable.

Images are validated locally first — format, byte size and pixel count are read from the file's
own header — so a violation is refused before anything is uploaded or shared.

### Comments

Comments go through the Drive API, which is generally available. The trade-off is anchoring:
Drive stores an `anchor` field faithfully but the Docs editor ignores it, so API-created comments
appear at document level rather than highlighting a passage. Quote the relevant text in the
comment body.

The Docs API added truly anchored comments in Developer Preview. Those are detected at runtime —
lazily probed, cached, with a negative result expiring after a day — so if the account gains
enrollment the feature starts working with no reconfiguration.

### Suggestion mode, and why it is probed rather than attempted

`mode: "suggest"` has **no fallback**: an agent that asked for a reviewable proposal must never
silently receive a committed edit instead.

Enforcing that took more than error handling, because **Google does not reject
`writeControl.writeMode` when the account lacks preview access — it silently drops the field and
commits the write.** Detecting the capability by attempting it and catching the failure therefore
never fires: there is no failure. The caller is told it succeeded, believes it made a suggestion,
and has changed the document.

So the capability is established *before* the user's document is touched, by writing a single word
in suggest mode into a throwaway document that is created and deleted for the purpose, then
checking whether Docs recorded it as a suggested insertion. That runs at most once and the answer
is cached. Where a capability fails loudly, the cheaper attempt-and-catch path is still used.

## Development

```bash
npm run typecheck
npm test
npm run dev       # rebuild on change
```

Tests run against recorded document fixtures with no network access.

## Relationship to Google's official Docs MCP server

Google ships a first-party remote MCP server (`docsmcp.googleapis.com`) exposing two tools,
`read_doc` and `update_doc`, which are thin passthroughs over `documents.get` and
`documents.batchUpdate` — same absolute indices, same raw JSON AST. It requires the same Cloud
project and OAuth scopes as this server, plus an additional API and Developer Preview enrollment.

This project builds the layer Google did not: the semantic one. The two can be registered side by
side in the same client; nothing here needs to adapt to it.

## License

MIT
