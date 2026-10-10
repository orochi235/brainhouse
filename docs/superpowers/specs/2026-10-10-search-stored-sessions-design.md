# Search over stored sessions

**Status: unbuilt.** Nothing here exists yet. Once built, fold what is still
true into `2026-10-08-transcript-search-design.md` (its "Indexing" and "Disk
bound" paragraphs change) and delete this file.

This is for whoever builds it. It answers: how a session stays searchable
after Claude Code deletes its transcript, given that icehouse
(`~/src/icehouse`) has kept a compressed copy.

## The problem

Claude Code deletes a transcript once it has sat idle past
`cleanupPeriodDays` (90 in the main harnesses). The search worker's scan then
calls `prune`, which deletes that file's rows. icehouse copies every
transcript into a store at `~/.icehouse` before that happens, one zstd file
per original plus a SQLite manifest, but brainhouse never reads it. The first
90-day deletions land around 2026-12-08.

## What changes

A file's rows stay in the index for as long as icehouse holds the file. The
scan decides per indexed or stored transcript:

| Live file | icehouse store | In the manifest | The scan |
|---|---|---|---|
| present | any | any | indexes from the live file, as today |
| gone | open | yes | keeps the rows; reads any bytes it never indexed from the store |
| gone | open | no | prunes |
| gone | unreachable (drive unplugged) | unknown | keeps the rows, reads nothing |
| gone | not set up (`~/.icehouse` does not exist) | none | prunes, as today |

The fourth row matters most: `~/.icehouse` is a symlink to an external SSD,
and unplugging it must not empty the index.

Most deleted sessions need no reading at all, because the worker indexed them
while they were live. The store is read only for bytes the index lacks: after
a rebuild from nothing (a schema bump, a deleted database) or for a transcript
that was written and deleted while brainhouse was down.

## Keys stay as paths

`files.path` stays the key, and a stored file is indexed under the path it
had when live. icehouse keys a file by `root` (the config dir's name without
its dot, `claude-msb`) and `rel` (its path under that dir's `projects`), so
the original path is `~/.<root>/projects/<rel>`. A stored file is indexed
only when that path falls under a root brainhouse is configured to watch,
which keeps account labels and the roots preference working unchanged.

The schema does not change, so the existing 1.09 GB index is not rebuilt.
`TODO.md` proposed keying on session and agent ID instead; the path already
survives the move from live to stored, and one session ID can appear under
two project dirs.

## Reading from the store

`Ingester.step` reads a stretch of bytes from an offset and indexes the
complete lines in it. That read becomes a parameter: the live reader is
today's `readCompleteLines`, and the stored reader slices a buffer. The worker
decompresses a stored file whole when it reaches the front of the queue,
holds that one buffer until the file is caught up, and steps through it at
the same 1 MB per step, so queries wait no longer than they do now. The
largest transcript in the store today is 47 MB. A worker restart mid-file
decompresses again and resumes from the saved offset.

For a stored file, `needsWork` compares the row's size and mtime with the
manifest entry instead of a `stat`. The manifest floors `mtimeMs`, so the
first comparison after a file moves to the store reports work, finds no new
bytes, and records the manifest's values.

## icehouse as a library

icehouse gains `src/index.ts` and an `exports` map:

```ts
/** Null when the store is not set up; throws StoreMissing when it is set up but unreachable. */
export function openArchive(dir?: string): Archive | null;

export interface Archive {
  /** Every stored `.jsonl`: root, rel, sessionId, size, mtimeMs. */
  transcripts(): Entry[];
  /** One stored file, decompressed. */
  read(root: string, rel: string): Buffer;
  close(): void;
}

export { findRoots, listSessions, openTranscript, StoreMissing };
```

- The manifest opens read-only for `openArchive`; today's constructor runs
  `CREATE TABLE IF NOT EXISTS` on every open.
- This closes icehouse's "Bulk reads" TODO.
- icehouse has no build step. Node imports its `.ts` through a symlinked
  dependency (checked under Node 26.11.1). brainhouse's `tsc` needs
  declarations, so icehouse emits `dist/*.d.ts` from a `prepare` script and
  points `exports.types` at them.
- brainhouse lists `icehouse` under `optionalDependencies` as
  `file:../icehouse` and loads it with a dynamic `import()` inside the worker.
  A failed import behaves as "not set up".

## Disk bound

The index stops tracking the live corpus and starts tracking the archive,
which only grows. Measured today: the index is 1.09 GB for 6.4 GB of
transcripts spanning 31 days, so it grows by about 1.1 GB a month.

A cap bounds it: `search.maxIndexGb` in prefs. After a scan, while the
database file is over the cap, the worker drops the docs of the stored-only
file with the oldest `last_ts` and keeps its `files` row with `offset` equal
to its size, so the next scan does not read it back in. A capped-out session
stays in icehouse and leaves search. Live files are never evicted.

**Open: the cap's default.** 10 GB holds roughly nine months at the current
rate.

## Results

A result group whose live file is gone shows a "stored" mark where a live
session shows its dot. The worker sets it with an `existsSync` per group on
the page.

## Hazards to check first

- **Drive access.** brainhouse's server runs under a LaunchAgent, and macOS
  gates removable volumes per program. Confirm the service can read
  `~/.icehouse/manifest.db` before building on it.
- **`tsc` and the sibling's sources.** Confirm `exports.types` keeps
  brainhouse's compile from pulling icehouse's `.ts` under its `rootDir`.

## Testing

- The scan table, row by row, against a temp root, a temp store, and a temp
  database: rows kept when the live file goes, pruned when the manifest lacks
  it, and kept when the store is unreachable.
- A rebuild from an empty database indexes a stored-only transcript, and its
  hits match the ones the live file produced.
- A stored file larger than one step is indexed across several, and resumes
  after the worker is recreated mid-file.
- The cap evicts the oldest stored-only file first, never a live one, and an
  evicted file is not read back on the next scan.
- icehouse: `openArchive` returns null with no store, throws with a dangling
  one, and never writes to the manifest.
