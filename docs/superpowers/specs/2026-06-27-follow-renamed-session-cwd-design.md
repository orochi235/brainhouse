# Follow a renamed session cwd

## Problem

A session's working directory is recorded once, from the first `cwd` seen in its
transcript, and never updated (`session.ts:864`, `if (panel.cwd) return`). When
the user renames that directory *in place* on disk, brainhouse keeps pointing at
the old path:

- `findRepoRoot(oldPath)` returns `null` (the path no longer exists / has no
  `.git`), so there's no `repo_root` to group by.
- Project grouping falls back to the cwd *leaf*, which differs per rename, so the
  same project's sessions fragment across stale names instead of collapsing into
  one widget.
- The `.hued` theme stops resolving.

Observed in the wild: `~/src/brother-lbx-editor` was renamed several times
(`brother-lbx` → `lbx-editor` → `brother-lbx-editor`), even mid-session (one
transcript's `cwd` flips from `…/brother-lbx-editor` to `…/lbx-editor` partway
through). The sessions scattered across three "projects" and the current
directory shows up wrong / not at all.

Critically, **nothing in the server notices the disappearance today.** The
watcher only watches the Claude transcript dirs (`~/.claude*/projects/…`), never
the session source dirs. A source-dir rename fires no event — we just hit a null
repo root lazily and silently.

## Goal

Detect when a live session's cwd disappears, find where it was renamed to, and
re-point the session at the new path so the UI reconciles (correct project name,
re-resolved theme, fragments collapse back into one project widget).

## Scope

In scope:

- Renames that happen **while the server is running and watching that session**
  (i.e. we recorded the cwd's inode while it still existed).
- **Same-parent** renames (`mv ~/src/old ~/src/new`).

Explicitly out of scope (for now):

- A cwd already gone before we ever saw it — no recorded inode to match against,
  so it's left as-is (current behavior).
- Cross-parent moves (`mv ~/src/x ~/projects/x`).
- Retroactively fixing historical fragments whose directories are already gone.
- Any UI affordance beyond the automatic re-stamp.

## Design

### 1. Inode recording (monitor, piggybacked on the theme poll)

`MonitorService.pollThemes` already walks every live panel's cwd every 10s
(sequentially, post the recent retention/sequential-poll change). We add one
`stat(cwd)` per panel per tick and keep a module-level
`Map<string, { dev: number; ino: number }>` keyed by cwd path. The first time a
cwd is observed to exist, record its inode. Cost: one extra `stat` per live
session per 10s — negligible, and the loop is already sequential.

### 2. Detection

In the poll loop, when `stat(cwd)` throws `ENOENT` **and** the inode map has an
entry for that cwd, run the rename search once:

- **Hit** → re-stamp (step 4), re-key the inode map (delete old cwd key, set the
  new cwd key to the same inode), and resolve the theme for the new path.
- **Miss** (real delete, or moved to a different parent) → drop the inode entry
  so we don't re-`readdir` the parent every tick.

A cwd with no recorded inode that throws `ENOENT` is ignored (the documented
limitation) — we never saw it alive, so there's nothing to match.

### 3. Rename search — `findDirByInode(parent, dev, ino)`

New isolated module `server/src/findRenamed.ts`. Pure I/O, no app state:

```
findDirByInode(parentDir, dev, ino): Promise<string | null>
```

`readdir(parentDir, { withFileTypes: true })`, then `stat` each **directory**
child and return the absolute path of the one whose `(dev, ino)` matches, else
`null`. Compares `dev` as well as `ino` to stay correct across filesystems.
Returns `null` (not throw) if the parent itself is gone. Runs only on a
disappearance, so the `readdir` + N `stat`s are rare.

### 4. Re-stamp — `SessionStore.relocatePanel(panelId, newCwd): Delta[]`

The single sanctioned override of the "first cwd wins" lock. Mirrors the shape
of `setTheme`:

- no-op (returns `[]`) if the panel is unknown or already at `newCwd`;
- otherwise set `panel.cwd = newCwd`, `panel.repo_root = findRepoRoot(newCwd)`,
  persist the panel, and return a single `panel_upsert` delta.

The monitor emits the returned deltas. Because `repo_root` is recomputed from the
new path, any sibling sessions that now share it collapse into one project
widget automatically; if the renamed dir now has a `.git` it didn't before, the
repo root resolves correctly.

### Data flow

```
pollThemes  (every 10s, sequential per live panel)
  └─ for each panel with a cwd:
       stat(cwd)
         ├─ ok:     record inode[cwd] if absent → loadThemeFor(cwd)   (as today)
         └─ ENOENT:
              inode[cwd] known?
                ├─ no:  ignore (never saw it alive)
                └─ yes: findDirByInode(dirname(cwd), dev, ino)
                          ├─ hit newCwd: store.relocatePanel(id, newCwd)
                          │              → emit deltas
                          │              → rekey inode map (cwd → newCwd)
                          │              → loadThemeFor(newCwd)
                          └─ miss:       drop inode[cwd]
```

## Testing

- **`findDirByInode`** (unit): create a temp parent + child dir, capture its
  inode, `rename` the child, assert it returns the new path; assert `null` after
  the child is deleted; assert `null` when the parent doesn't exist.
- **`SessionStore.relocatePanel`** (unit): seed a panel, relocate it, assert
  `cwd` + `repo_root` re-stamped, panel persisted, and a `panel_upsert` delta
  returned; assert no-op delta when already at the target.
- **Monitor wiring** (focused): with a real temp dir, seed a panel at that cwd,
  prime the inode map via a poll, `rename` the dir on disk, run another poll, and
  assert the panel's cwd followed the rename.

## Risks / notes

- Inode reuse after delete-then-create is possible in principle, but the match
  only runs when the *old* cwd is gone and we scan the *current* parent — a
  freshly-created unrelated dir would need to have reused the exact inode of the
  vanished one AND live in the same parent. Comparing `dev` + `ino` and only
  acting on a disappearance makes this vanishingly unlikely.
- The inode map is in-memory only; it rebuilds naturally on the next poll after a
  restart. A rename that happens exactly during the restart window is missed —
  acceptable.
