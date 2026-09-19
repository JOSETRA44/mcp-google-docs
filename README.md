# gdocs-native

**Give an AI agent real control over your Google Docs — by intent, not by index.**

```
"Read my thesis draft and summarize the methodology section."
"Replace the paragraph about deadlines with this new wording."
"Add a table of Q3 results after the Findings heading."
"Reply to Ana's comment and resolve it."
```

No character offsets. No corrupted documents when a colleague is editing at the same time.

---

## Quick start

```bash
npx gdocs-native setup
```

That one command registers the server with every MCP client on your machine and signs you in to
Google. Restart your client and you're done.

You'll need a Google OAuth client first — a one-time, three-minute step:

<details>
<summary><b>Creating your OAuth client (click to expand)</b></summary>

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project (or pick one).
2. Enable **both** APIs — Drive alone is not enough, and a project missing the Docs API signs in
   fine and then fails on the first edit:
   - [Google Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
3. **APIs & Services → OAuth consent screen** → External → fill in the required fields → add your
   own Google account under **Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   application type **Desktop app**. Desktop clients may redirect to any local port, which is what
   the sign-in flow uses.
5. Download the JSON, then:

```bash
npx gdocs-native auth --credentials ~/Downloads/client_secret_....json
```

Google will warn that the app is unverified. That is expected for a personal OAuth client; choose
**Advanced → Go to (your app)**. Nothing leaves your machine — the token is stored locally in
`~/.gdocs-native/`.

</details>

### Or let your agent install it

If you're already talking to a coding agent, paste this and it will do the whole setup itself:

````text
Install the gdocs-native MCP server for me, then verify it works.

1. Run: npx -y gdocs-native install
   This detects every MCP client on this machine (Claude Code, Claude Desktop, Cursor,
   Windsurf, VS Code, Cline) and registers the server. It merges into existing config,
   backs up first, and is safe to re-run.

   If that fails, add this to my MCP client's config by hand — the key is "mcpServers"
   in every client except VS Code, which uses "servers":

   {
     "mcpServers": {
       "gdocs-native": { "command": "npx", "args": ["-y", "gdocs-native", "mcp"] }
     }
   }

   Config locations:
     Claude Code     ~/.claude.json          (better: run `claude mcp add-json`)
     Claude Desktop  %APPDATA%\Claude\claude_desktop_config.json
                     ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
     Cursor          ~/.cursor/mcp.json
     Windsurf        ~/.codeium/windsurf/mcp_config.json
     VS Code         %APPDATA%\Code\User\mcp.json  ("servers" key)
     Cline           %APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json

2. Run: npx -y gdocs-native doctor
   Every line should say "ok". If it reports missing OAuth credentials, walk me through
   creating a Desktop-app OAuth client in Google Cloud Console and enabling BOTH the
   Google Docs API and the Google Drive API — Drive alone signs in fine and then fails on
   the first edit. Then run: npx -y gdocs-native auth --credentials <path-to-downloaded.json>

3. Install the usage skill: npx -y skills add JOSETRA44/mcp-google-docs

4. Tell me to restart this client, and afterwards confirm you can see the doc_* tools by
   listing my Google Docs.
````

### Teach your agent to use it well (recommended)

```bash
npx skills add JOSETRA44/mcp-google-docs
```

Installs a skill into Claude Code, Cursor, Codex, Windsurf and 70+ other agents that teaches the
workflow — orient with the outline, read *addressed*, edit by handle — plus how to recover from the
refusals the server deliberately produces instead of guessing. Without it agents still work, but
they tend to read the whole document when the outline would do, and to address blocks by quoting
text where a handle would be unambiguous.

Check everything at any time:

```bash
npx gdocs-native doctor
```

```
  ok    OAuth client credentials — 111495656098-sl0k8u9rcjq…
  ok    Stored session — refresh token present
  ok    Granted scopes — 4 of 4
  ok    Drive API — you@gmail.com
  ok    Docs discovery — 42 document(s) visible
  ok    Docs API — reachable and enabled
```

---

## Commands

| Command | What it does |
|---|---|
| `setup` | Register with all detected MCP clients, then sign in. Start here. |
| `install` | Register only. `--client cursor` for one, `--dry-run` to preview, `--local` for a checkout. |
| `uninstall` | Remove from every client config. |
| `auth` | Sign in. `--credentials <path>` to import a downloaded OAuth client. |
| `doctor` | Diagnose credentials, scopes, and API reachability. |
| `ls [query]` | List or search your documents. |
| `mcp` | Run the server over stdio (what clients invoke). |

`install` detects **Claude Code, Claude Desktop, Cursor, Windsurf, VS Code and Cline**. It merges
into existing config, backs up first, refuses to touch a file it cannot parse, and is idempotent.
For Claude Code it delegates to `claude mcp add-json`, because that file is written by the
application while it runs.

### Manual configuration

If you'd rather do it by hand, the same JSON works in every client
(VS Code uses `servers` instead of `mcpServers`):

```json
{
  "mcpServers": {
    "gdocs-native": { "command": "npx", "args": ["-y", "gdocs-native", "mcp"] }
  }
}
```

---

## Tools

| Tool | Purpose |
|---|---|
| `doc_list` · `doc_create` | Find or create documents |
| `doc_convert` | Turn an uploaded `.docx`/`.odt`/`.rtf` into a native Google Doc |
| `doc_read` | Read as Markdown — `clean` for prose, `addressed` for editing |
| `doc_outline` | Headings with handles; cheapest way to orient in a long document |
| `doc_search` | Every occurrence of a phrase, with handles and context |
| `doc_stats` | Word/character count, structure breakdown, reading time |
| `doc_history` | Stored revisions and who made them |
| `doc_export` | Download as PDF, .docx, .odt, .rtf, .txt, HTML, EPUB or Markdown |
| `doc_replace` | Replace a block's text, or a phrase within it |
| `doc_replace_all` | Replace every occurrence throughout the document in one pass |
| `doc_insert` | Insert a paragraph at start/end, or before/after a block |
| `doc_delete` | Delete a block or a matched phrase |
| `doc_format` | Bold, italic, underline, strikethrough, size, link |
| `doc_style` | Headings, title, body text, bulleted/numbered lists |
| `doc_write_markdown` | Write a formatted section — headings, lists, tables, links, code |
| `doc_insert_table` · `doc_table_write` | Insert a table, then fill it by row and column |
| `doc_insert_image` | Insert an image from disk, a URL, or Drive |
| `doc_comments_list` · `doc_comment` · `doc_comment_reply` | Read and take part in comment threads |

Targets are given as **one** of `block_id`, `find`, `heading`, or `anchor`. Every write tool takes
`mode: "direct" | "suggest"` and reports the revision it started from, so any edit is traceable to
a restore point in Drive's version history.

---

## Using it

Just talk to your agent normally:

```
Read https://docs.google.com/document/d/YOUR_ID/edit and summarize the methodology.

In my thesis draft, rewrite the paragraph that starts "Los resultados muestran"
so it's clearer, keeping the same citations.

Add a Limitations section after the Discussion heading, with three bullets.

Insert the chart at C:\work\figure3.png after the paragraph about growth.

What comments are open on my report? Reply to Ana's and resolve it.
```

### Ready-to-use prompt

If you didn't install the skill, paste this once at the start of a session to get the same
behaviour:

```text
You can edit my Google Docs with the gdocs-native tools. Work this way:

1. Start with doc_outline to see the structure cheaply — don't read a long document
   in full unless you need its prose.
2. Before editing anything, call doc_read with format:"addressed". Every block comes
   back prefixed with a handle like {#a3f1}.
3. Edit by passing block_id with that handle. It's unambiguous and survives someone
   else editing the document while you work. Never try to compute character positions —
   there are none in this tool surface.
4. Pass exactly one target per call: block_id, find, heading, or anchor.
5. Use doc_write_markdown for anything substantial — headings, lists, tables, links and
   emphasis all become real Docs formatting. Use doc_insert only for a single plain
   paragraph.

Expect these refusals and handle them rather than retrying:
- "appears N times" → pick one of the returned handles, or pass occurrence.
- "No block with id ..." → that block was edited, so its content-derived handle changed.
  Read addressed again and use the new one.

Read before you rewrite: if I ask you to fix a section, find out what it currently says
rather than replacing it with what such a section usually says. Match the document's
existing language and citation style. Never invent a citation or statistic to fill a gap —
tell me instead. Tell me the "revision before" value after any significant edit so I can
undo it from Drive's version history.
```

---

## How it works

The Docs API addresses documents by **absolute integer indices**. Every insertion shifts every
index after it, and a colleague typing in another window invalidates an agent's arithmetic
silently — producing writes that land in the wrong place.

This server never exposes an index.

**Content-addressed blocks.** Every block gets a handle derived from a hash of its text, like
`{#a3f1}`. An index is a coordinate that stops being true when anything before it changes; a
content hash is an *identity* that survives the block moving anywhere in the document.

**Server-side operational transformation.** Every write declares the revision it was computed
against via `writeControl.targetRevisionId`. Google transforms the batch against whatever
collaborators committed meanwhile — the same engine that powers the web editor. Not a lock, not
last-write-wins.

**Just-In-Time resolution.** Indices are never cached. Every mutation re-reads, re-resolves, plans,
orders requests by descending index, and writes. A revision conflict re-plans from scratch rather
than replaying stale requests.

**Ambiguity is an error, never a guess.** If "replace the paragraph about deadlines" matches three
paragraphs, you get the three candidates back — not a confidently wrong edit.

<details>
<summary><b>Details worth knowing (click to expand)</b></summary>

### Two invariants enforced centrally

- **`suggestionsViewMode` is always `SUGGESTIONS_INLINE`** — the only read mode whose indices are
  valid for `batchUpdate`. Every other mode returns indices computed against a preview.
- **`includeTabsContent` is always true** — without it Google returns only the first tab, and edits
  built from that read silently target tab one.

### One character, one index

Within a block, one character of text equals one document index. Non-text elements — images, page
breaks, footnote references, person chips — each contribute exactly as many placeholder characters
as they occupy indices. Offset-to-index conversion is then plain addition everywhere, with no
offset table to keep in sync.

### Inserted paragraphs inherit style, always

Inserting before a paragraph mark puts the text inside that paragraph; splitting it leaves both
halves carrying the original style, so a paragraph added after a heading becomes a heading.
Inserting after the mark inherits the *following* paragraph instead. There is no position that
avoids it, so the inheritance is undone explicitly. Pass `match_style: true` when you want it kept
— another entry in a reference list, another line of an address.

### Images

`insertInlineImage` makes Google's servers fetch a URI **with no authentication context at all**,
so a file on your disk or a private file in your own Drive is invisible to the API meant to insert
it. `doc_insert_image` uploads the bytes, grants link access, inserts, then revokes and deletes.
The exposure lasts seconds, is bounded by cleanup that runs even when the insert fails, and targets
an unguessable 33-character file id. Format, byte size and pixel count are validated from the
file's own header first, so a violation is refused before anything is uploaded.

### Suggestion mode is probed, not attempted

`mode: "suggest"` has **no fallback** — an agent that asked for a reviewable proposal must never
silently receive a committed edit. Enforcing that took more than error handling: **Google does not
reject `writeControl.writeMode` when the account lacks Developer Preview access. It silently drops
the field and commits the write.** Detection by attempt-and-catch never fires, because there is no
failure. So the capability is established before your document is touched, by writing one word in
suggest mode into a throwaway document that is created and deleted for the purpose. That runs at
most once and is cached.

### Comments

Comments go through the Drive API, which is generally available. Drive stores an `anchor` field
faithfully but the Docs editor ignores it, so API-created comments appear at document level rather
than highlighting a passage — quote the relevant text in the comment body.

### Office files

The Docs API cannot read or edit `.docx` at all; Drive only stores and displays them. `doc_convert`
produces a native copy and leaves the original untouched.

</details>

---

## Relationship to Google's official Docs MCP server

Google ships a first-party remote server (`docsmcp.googleapis.com`) exposing two tools, `read_doc`
and `update_doc` — thin passthroughs over `documents.get` and `documents.batchUpdate`, with the
same absolute indices and the same raw JSON AST. It needs the same Cloud project and scopes as this
server, plus an extra API and Developer Preview enrollment.

This project builds the layer Google did not: the semantic one. The two can be registered side by
side; nothing here needs to adapt to it.

---

## Development

```bash
npm install
npm run typecheck
npm test          # 84 tests, no network — runs against recorded fixtures
npm run build
node dist/index.js install --local   # point your clients at this checkout
```

## License

MIT · [JOSETRA44/mcp-google-docs](https://github.com/JOSETRA44/mcp-google-docs)
