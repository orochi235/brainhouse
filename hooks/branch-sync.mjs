#!/usr/bin/env node
/**
 * SessionStart hook — refreshes remote refs, then fast-forwards the current
 * branch from its upstream when the working copy holds no active work.
 *
 * A session that starts on a stale branch answers "what is in the repo right
 * now" wrongly: missing files, missing skills, missing config that landed after
 * the last local commit. This closes that gap before the model reads anything.
 *
 * The two halves have different safety bars, so they are gated separately. The
 * fetch is a pure read into remote refs and runs whenever there is a work tree;
 * holding it behind the fast-forward's guards left FETCH_HEAD hours stale in
 * any repo carrying an untracked file, which in turn made the statusline's
 * `trunk+N` drift count understate how far behind the branch was. The
 * fast-forward mutates, so it still refuses anything ambiguous — a dirty tree,
 * a detached HEAD, an in-progress merge/rebase/bisect, no upstream, or a branch
 * that has diverged. `merge --ff-only` is the only mutation, so nothing local
 * can be lost.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { estimateTokens, recordHookOverhead } from './lib/overhead.mjs';

const exec = promisify(execFile);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** Returns trimmed stdout, or null on any non-zero exit. */
async function git(cwd, args, timeout = 10_000) {
  try {
    const { stdout } = await exec('git', args, { cwd, timeout, encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Why this checkout must be left alone, or null to proceed.
 * Order matters only for the message; every check is independent.
 */
async function blockedBecause(cwd) {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return 'not a git work tree';

  const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) return 'detached HEAD';

  const gitDir = await git(cwd, ['rev-parse', '--absolute-git-dir']);
  if (gitDir) {
    const { access } = await import('node:fs/promises');
    for (const marker of [
      'MERGE_HEAD',
      'rebase-merge',
      'rebase-apply',
      'CHERRY_PICK_HEAD',
      'BISECT_LOG',
    ]) {
      const hit = await access(`${gitDir}/${marker}`).then(
        () => true,
        () => false,
      );
      if (hit) return `${marker} present — an operation is in progress`;
    }
  }

  // `-uno`: untracked files are not work in progress — a `CLAUDE.local.md` or a
  // scratch file would otherwise pin a repo one commit behind forever. Anything
  // they could actually clobber, `merge --ff-only` refuses on its own.
  const dirty = await git(cwd, ['status', '--porcelain', '-uno']);
  if (dirty === null) return 'git status failed';
  if (dirty !== '') return 'uncommitted changes';

  return null;
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || '{}');
  } catch {}
  const cwd = payload.cwd || process.cwd();

  if ((await git(cwd, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return;

  const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const upstream = branch
    ? await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    : null;

  // Fetch only what this branch tracks. A whole-remote fetch is slower and the
  // extra refs are not what the session is about to read — but with no upstream
  // to narrow it, the plain form is what keeps FETCH_HEAD current.
  const fetched = upstream
    ? await git(cwd, ['fetch', '--quiet', upstream.split('/')[0], branch], 15_000)
    : await git(cwd, ['fetch', '--quiet'], 15_000);

  if (!upstream || fetched === null) return;
  if (await blockedBecause(cwd)) return;

  const before = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  const counts = await git(cwd, ['rev-list', '--left-right', '--count', `HEAD...@{u}`]);
  if (!counts) return;
  const [ahead, behind] = counts.split(/\s+/).map(Number);
  if (!behind) return;
  if (ahead) {
    // Diverged: a merge or rebase is the user's call, not a hook's.
    const out = {
      hookEventName: 'SessionStart',
      additionalContext:
        `Branch \`${branch}\` has diverged from \`${upstream}\`: ${ahead} ahead, ${behind} behind. ` +
        'Left untouched — reconciling it is a decision, not a fast-forward.',
    };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
    await recordHookOverhead({
      sessionId: payload?.session_id ?? payload?.sessionId,
      hookName: 'branch-sync',
      tokens: estimateTokens(out.additionalContext),
    });
    return;
  }

  if ((await git(cwd, ['merge', '--ff-only', '@{u}'], 20_000)) === null) return;
  const after = await git(cwd, ['rev-parse', '--short', 'HEAD']);

  const out = {
    hookEventName: 'SessionStart',
    additionalContext:
      `Working copy was clean and \`${branch}\` was ${behind} behind \`${upstream}\`, ` +
      `so it was fast-forwarded ${before} → ${after} before this session started. ` +
      'Anything you remember about this branch predates those commits.',
  };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
  await recordHookOverhead({
    sessionId: payload?.session_id ?? payload?.sessionId,
    hookName: 'branch-sync',
    tokens: estimateTokens(out.additionalContext),
  });
}

main().catch(() => process.exit(0));
