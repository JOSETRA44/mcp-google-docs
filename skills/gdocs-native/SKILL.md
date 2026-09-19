---
name: gdocs-native
description: >-
  Read, write, format and comment on the user's real Google Docs through the gdocs-native MCP
  server. Use this skill whenever the user mentions a Google Doc, a Docs URL, "my document",
  "el documento", a thesis or report draft, or asks you to read, summarize, rewrite, restructure,
  format, add a table or an image to, or comment on something that lives in Google Docs — even when
  they don't name Google Docs explicitly, and even when they only paste a docs.google.com link.
  Also use it when a Word or .docx file in their Drive needs editing. Prefer this over guessing at
  document contents or asking the user to paste text, since these tools read and edit the live
  document.
---

# Operating Google Docs

The `gdocs-native` MCP server lets you edit a user's real, live Google Docs. Someone may be typing
in the same document while you work.

## The one idea that matters

The Google Docs API addresses documents by absolute character indices, and every insertion shifts
every index after it. This server hides that entirely. **You never compute, pass, or reason about
a number.** Instead every block carries a short handle derived from its content:

```
## {#030d} Hallazgos

{#c0c0} Este párrafo lleva negrita y cursiva.
```

`{#030d}` is that heading's identity. It stays valid if the document grows above it, if a
collaborator edits elsewhere, even if the block moves pages. It only changes if *that block's own
text* changes — which is why a stale handle means "re-read", not "something broke".

If you ever find yourself wanting a character offset, you've misread the tool surface. There isn't
one.

## Workflow

**1. Orient before reading everything.** `doc_outline` returns just the headings with their
handles. On a fifty-page thesis that is a few hundred tokens instead of tens of thousands, and it's
usually enough to decide what you actually need.

**2. Read in the right mode.** `doc_read` has two:

- `format: "clean"` — prose only. Use it to summarize, answer questions, or quote.
- `format: "addressed"` — every block prefixed with its handle. **Read this before editing**, because
  the handles are what the write tools take.

Reading clean and then trying to edit means addressing blocks by quoting their text, which works
but is where ambiguity errors come from.

**3. Edit by handle.** Pass `block_id` from an addressed read. It's unambiguous and survives
concurrent edits.

## Addressing a target

Every write tool takes **exactly one** of these. Passing two is an error, not a preference order:

| Field | Use when |
|---|---|
| `block_id` | You just did an addressed read. Always prefer this. |
| `find` | You know the exact text and it appears once. |
| `heading` | You're targeting a section heading by its words. |
| `anchor` | A named range was created earlier. |

`find` matches through Docs' silent rewrites — straight quotes match curly ones, collapsed spacing
matches. If nothing matches literally it falls back to the closest paragraph.

### When it refuses

**"appears 4 times"** — the tool will not guess. It returns the candidates with their handles.
Pick one and pass `block_id`, or pass `occurrence: 2`. Don't retry the same call hoping for a
different outcome.

**"No block with id ... It was probably edited"** — expected, not a failure. Editing a block changes
its content-derived handle. Re-read addressed and use the new one.

**"similarly close to several blocks"** — your text was too vague to edit safely. Quote something
more distinctive or read addressed first.

## Choosing a write tool

**`doc_write_markdown` for anything substantial.** Headings, bold, italic, links, bulleted and
numbered lists, tables, code, blockquotes and rules all become real Docs formatting. Write ordinary
Markdown; don't hand-build it paragraph by paragraph.

**`doc_insert` for a single plain paragraph.** Position it with `end`, `start`, or `after`/`before`
plus a target.

**`doc_replace`** swaps a block's text, or just a matched phrase within it. `whole_block: true`
replaces the entire containing block rather than only the match.

**`doc_format`** applies bold/italic/underline/strikethrough/size/link. Only the properties you pass
change — making a phrase bold won't reset its colour or its link.

**`doc_style`** converts a block to a heading, title, body text, or a bulleted/numbered list.

**`doc_replace_all`** changes every occurrence of a phrase in one pass — renaming a term, fixing a
recurring misspelling, updating a year. Reach for it instead of calling `doc_replace` in a loop,
which would need a fresh read between each call. It reports how many it changed.

**`doc_table_write`** fills a table by row and column, which is far easier than addressing each
cell by handle. Get the table's id (`t1`, `t2`) from an addressed read. An empty string leaves a
cell as it was, so you can update one column without touching the rest.

**`doc_export`** downloads the document as PDF, `.docx`, `.odt`, `.rtf`, plain text, HTML, EPUB or
Markdown — for when the user wants something to submit, print or send.

**`doc_stats`** counts words, characters and structure, with a reading-time estimate. Answer
questions about length with this rather than reading the whole document and counting yourself.

### `match_style` — the one that isn't obvious

An inserted paragraph normally becomes plain body text, which is right almost always: it's what
stops a paragraph added after a heading from becoming another heading.

But when you're **extending a run of uniformly formatted paragraphs** — one more entry in a
reference list with a hanging indent, one more line of an address block — that reset makes your
addition the only one that looks wrong. Pass `match_style: true` there.

## Reporting what you did

Write tools return the revision the edit started from. Mention it when the user might want to undo:
it's the restore point in Drive's version history. If a tool says the edit was applied on attempt 2,
a collaborator was editing simultaneously and your change was merged against theirs — worth telling
the user, since it means the document moved under you.

## Things that surprise people

**Word files can't be edited.** A `.docx` in Drive is not a Google Doc; the Docs API can't touch it.
You'll get a clear error saying so. `doc_convert` makes a native copy and leaves the original alone
— tell the user you're working on a converted copy rather than doing it silently, since they now
have two files.

**Images from disk just work.** Pass `file_path` to `doc_insert_image`. The server handles the fact
that Google fetches image URIs with no credentials, hosting the file for a few seconds and cleaning
up afterwards. PNG, JPEG and GIF; up to 50 MB and 25 megapixels, checked before anything uploads.

**Comments attach to the document, not to a passage.** The Drive API stores an anchor but the Docs
editor ignores it. Quote the text you're discussing inside the comment body so the reader knows what
you meant.

**Tables need two steps.** `doc_insert_table` creates an empty grid — cells don't exist until the
table does. Read addressed to get the cell handles, then fill them with `doc_replace`.
`doc_write_markdown` does this for you when the Markdown contains a table.

**`mode: "suggest"` may be refused.** It needs Developer Preview access. There is deliberately no
silent fallback to a direct write, so a refusal means the document was not touched.

## Judgement

You are editing something a person cares about, often something they're graded on or judged by.

Read before you write. When the user says "fix the conclusion", find out what the conclusion
currently says rather than replacing it with what a conclusion usually says. Match the document's
existing voice, language and citation style — check how its other references or headings are
formatted before adding one.

For a large rewrite, say what you're about to change before doing it. Deleting a block removes the
paragraph entirely; if you meant to empty it rather than remove it, replace its text with `""`
instead.

Never invent a citation, statistic, or quotation to fill a gap in someone's document. If a
reference is needed and you don't have a real one, say so.
