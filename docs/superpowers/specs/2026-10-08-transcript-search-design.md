# Transcript search

**Status: built.**

This is for whoever builds transcript search and whoever changes it next. It
answers: how brainhouse indexes every transcript on disk, how a query runs, and
what the search modal does.

## What it does

A search field in the topbar searches every transcript under the roots
brainhouse watches (`resolveRoots`: the prefs' roots, or every `~/.claude…/projects`
when none are set): all history, live sessions included, and sessions Claude
Code has since deleted, for as long as icehouse (`~/src/icehouse`) holds a
copy. Results open in a
modal with the hits on the left and the matching session on the right, scrolled
to the hit. The menu bar helper has a search field that opens the same modal.

## Corpus

Every event `parseLine` produces that carries text: user prompts, assistant
replies, thinking, tool inputs, and tool output. Images are left out. Nothing is
capped. A sample of 40 transcripts (94 MB raw) built a 15.9 MB index uncapped
and 15.0 MB with tool output capped at 6 KB, so the cap saves about 6%. Scaled
to the 6.3 GB corpus, the index is about 1.07 GB.

## Architecture

| Piece | Where | Job |
|---|---|---|
| Search worker | `server/src/search/worker.ts` (`worker_thread`) | Owns `~/.brainhouse/search.db` (`BRAINHOUSE_SEARCH_DB` overrides). Indexes and answers queries. Works in chunks of about 50 ms and serves waiting queries before the next chunk. |
| Scan rules | `server/src/search/scan.ts` | Which transcripts a scan keeps, drops, and queues; where one file's next bytes come from; what leaves when the index is over its cap. |
| Byte sources | `server/src/search/reader.ts` | Complete lines from an offset, out of a live file or a decompressed stored copy. |
| Stored transcripts | `server/src/search/stored.ts` | What icehouse holds, keyed by the path each file had when live. Loads the `icehouse` package with a dynamic `import()`. |
| Worker handle | `server/src/search/service.ts` | Main-thread handle: posts messages, matches replies by id, restarts a crashed worker. |
| Query parser | `server/src/search/query.ts` | Pure: query string → terms, phrases, regex, and filters. |
| Router | `search` in `server/src/trpc.ts` | `query({ q, cursor })`, `transcript({ fileId, highlight })`, `docText({ docId })`, `status()`. |
| Open route | `POST /api/search/open` in `server/src/index.ts` | Body `{ q }`. Runs `open -b com.google.Chrome http://localhost:8765/?q=<encoded>`, or plain `open` when Chrome is missing. |
| Topbar field | `client/src/components/search/SearchField.tsx` | ⌘K or `/` focuses it. Typing opens the modal with the text carried over. Remembers recent queries in `localStorage`. |
| Modal | `client/src/components/search/SearchModal.tsx` | Opens in the lightbox. Query bar and filter chips across the top, results list on the left, reader on the right. |
| Deep link | `client/src/App.tsx` | `/?q=<text>` opens the modal with that query run, then removes `q` from the URL. |
| Menu item | `menubar.yaml` | `field: Search transcripts`, `post:` to the open route. |

## Schema

```sql
CREATE TABLE files (
  id INTEGER PRIMARY KEY, path TEXT UNIQUE, session_id TEXT, account TEXT,
  cwd TEXT, size INTEGER, mtime INTEGER, offset INTEGER
);
CREATE TABLE docs (
  id INTEGER PRIMARY KEY, file_id INTEGER, event_uuid TEXT, ts REAL,
  kind TEXT, tool TEXT, is_error INTEGER, text TEXT
);
CREATE VIRTUAL TABLE docs_fts USING fts5(
  text, content='docs', content_rowid='id', tokenize='trigram'
);
```

`kind` is the event kind. `tool` is the tool name on `tool_use`, and on
`tool_result` it is copied from the matching `tool_use` in the same file. A
`meta` row records the schema version; a mismatch deletes the file and rebuilds
it.

## Indexing

- **Boot:** walk every root from `resolveRoots`. For each `.jsonl`, compare
  size and mtime with its `files` row, and index from the stored `offset` to the
  last complete line. A file that shrank is reindexed from zero.
- **Live:** whenever the watcher reads new bytes from a file, the monitor tells
  the worker that path. The worker indexes it on its next chunk, so new lines
  are searchable within about a second.
- **Root changes:** `setRoots` sends the new root list, and the worker rescans
  with it.
- **Cost:** the first build is about 75 s of one core (scaled up from the
  sample); after that, only appended bytes are indexed.

## Deleted sessions

Claude Code deletes a transcript once it has sat idle past
`cleanupPeriodDays`. icehouse copies each one first into `~/.icehouse`, a
symlink to an external drive, as one zstd file per original plus a SQLite
manifest. A scan decides what happens to a transcript whose live file is gone:

| icehouse store | In its manifest | The scan |
|---|---|---|
| open | yes | keeps the rows; reads from the store only bytes it never indexed |
| open | no | deletes the rows |
| set up but unreachable (drive unplugged) | unknown | keeps the rows, reads nothing |
| not set up (`~/.icehouse` does not exist) | none | deletes the rows |

- **Keys are paths.** A stored file is indexed under the path it had when
  live, which icehouse rebuilds from its own key (`sourcePath`), and only when
  that path is under a watched root. The rows a live file produced are the
  rows it keeps after deletion.
- **A moved session is one transcript.** Claude Code moves a session's files
  when its project directory changes, and the store keeps the copy it made at
  the old path. A stored path is ignored while the same root, session, and
  agent is live anywhere, and of several stored copies only the newest counts.
- **The store is read rarely.** Most deleted sessions were indexed while live.
  The store supplies bytes after a rebuild from nothing, or for a transcript
  written and deleted while brainhouse was down. The worker decompresses that
  one file whole, holds it until it is caught up, and steps through it 1 MB
  at a time like a live file. A stored copy never grows, so its last line
  counts even without a newline.
- **No handle outlives a call.** The manifest is opened read-only and closed
  again on every scan and every read, so the drive can be ejected.
- **`icehouse` is an optional dependency** (`file:../../icehouse`). It runs as
  TypeScript; `tsc` checks against the `.d.ts` files its `prepare` script
  emits. A failed import behaves as "not set up".
- A result whose live file is gone carries `stored: true`, and the list shows
  "stored" beside its project.

## Disk bound

The index tracks the live corpus plus everything icehouse holds, and icehouse
only adds. Measured on 2026-10-10: 1.09 GB of index for 6.4 GB of transcripts
spanning 31 days.

`storage.searchIndexMaxGb` (20 by default, under Storage in Preferences) caps
the bytes the database has in use, which is its page count less its free
pages: deleting rows frees pages without shrinking the file. After a scan,
while the index is over the cap, the stored-only transcript that ended longest
ago is shelved: its docs go and its `files` row stays with `offset` set to its
size, so the next scan does not read it back. During a rebuild, a stored
transcript is shelved unread once the index is over. A live transcript is
never shelved. Raising the cap does not bring a shelved session back; deleting
`search.db` rebuilds from the store, newest first.

## Querying

| Syntax | Meaning |
|---|---|
| `foo bar` | Both substrings, case-insensitive, in the same event. |
| `"foo bar"` | That exact phrase. |
| `/fo+\.ts/` | A JS regex, with flag `i` by default. Flags after the closing slash replace the default: `/Foo/s` is case-sensitive. |
| `project:brainhouse` | Repo name of the session's cwd. |
| `account:pw` | Account label from the root (`CC`, `PW`, `MSB`), case-insensitive. |
| `role:you`, `ai`, `thinking`, `tool`, `out`, `error` | Event kind. `tool` is a tool input, `out` a tool result, and `error` a result with `is_error`. |
| `tool:Bash` | Tool name, case-insensitive. |
| `after:2026-09-01`, `before:7d` | Event time, as a date or a relative age (`h`, `d`, `w`). |
| `is:error` | Same as `role:error`. |

Terms and phrases of 3 or more characters go to `docs_fts` as trigram
`MATCH`. Shorter ones run as `LIKE` over the rows the other conditions leave.
A regex has its literal runs of 3 or more characters extracted (outside
alternations and optional groups) for `MATCH`, and every candidate is confirmed
with `RegExp`. A regex with no usable literal scans rows newest first within a
200 ms budget, and returns what it found and how far it got. The modal offers
"keep searching", which resumes from that point.

Each hit carries the match offsets in its text, so the client highlights
without searching again.

**Results** are grouped by session. Sessions come newest first by their latest
hit, with hits in chronological order inside each. A page holds 50 sessions;
each session shows its first 20 hits plus a count of the rest. The cursor
loads the next page.

**Titles, project names, and colors** come from the existing store and
`titler` on the main thread, joined onto results by session id, so the modal
and the panels never disagree.

## Modal

| Key | Action |
|---|---|
| ↑ ↓ | Previous or next hit. The reader follows. |
| ⇧↑ ⇧↓ | Previous or next session. |
| n, N | Next or previous match inside the reader. |
| ↵ | Focus the reader. |
| Esc | Out of the reader, then closes the modal. |

The query runs 150 ms after typing stops. Superseded queries are dropped.

The **reader** shows the session's indexed events, read back from the search
database by `search.transcript`, one row per event with its role and time. It
does not use the panel's view pipeline: that folds tool output into collapsed
capsules, and tool output is most of what matches, so a hit would land
somewhere neither visible nor highlightable. Rows with a match arrive whole,
with match ranges; other rows are cut to 600 characters and expand on click
(`search.docText`). The reader centers the first match of the current hit. The
client keeps the last 8 transcripts it opened.

The **footer** shows hits, sessions, and query time, in tabular figures, with
the time pinned at the right edge so it doesn't move the counts.

Zero results says so, and lists the filters in force so a stray `project:` is
visible. While the first index build is running, the footer shows its progress
and results carry a note that they are incomplete.

## Menu bar

```yaml
  - field: Search transcripts
    post: {url: "http://localhost:8765/api/search/open", body: {q: "{{query}}"}}
```

`post:` rather than `run: [open, -b, com.google.Chrome, …]`: perch passes
`{{query}}` to `run:` unencoded, which breaks a URL on `&`, `#` and `%`, while
it JSON-escapes holes in a `post:` body. The item needs perch 2.4.0 or later,
the first release with `field:`.

## Testing

- `query.ts`: every row of the syntax table, regex literal extraction, and
  malformed input (an unclosed quote, an invalid regex) reported rather than
  thrown.
- Indexer: append, partial trailing line, truncation, deletion, root change,
  and schema-version rebuild, against a temp directory and temp database.
- Deleted sessions (`stored.test.ts`), against a temp home and a real icehouse
  store: each row of the scan table, a moved session, a rebuild read from the
  store across several steps, and the cap.
- Router: `query` and `transcript` against a fixture corpus.
- `/api/search/open`: encoding of `a&b c#%`.
- Modal: keyboard navigation and the reader following the selection.
- A headless Playwright pass against the deployed service: the deep link, the
  topbar field, and the reader landing on a match.
