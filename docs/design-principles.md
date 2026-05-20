# Brainhouse — design principles

Cross-cutting guidance that shapes feature work and UX decisions. These
aren't behavioral contracts (those live in `assertions.md`) — they're the
*how to think about it* layer. Reference these in PR descriptions or
design notes when a decision turns on one.

## Users are programmers; expose the powerful primitive

Brainhouse is built for people who know how a regex behaves, what a glob
matches, what a CWD path looks like. When a config option could
reasonably be expressed as something simple-but-rigid (a dropdown of
preset strings, an enum of cases) or as something flexible-but-technical
(a regex, a glob, a path predicate, a tiny expression), **default to the
flexible primitive**.

Examples this shapes:

- A "filter sessions by project" UI should accept a path glob, not a
  dropdown of recently-seen cwds.
- A "hide tools matching X" pref should accept a regex, not a checkbox
  matrix of every tool name we've seen.
- A "session title rule" should accept a small expression (e.g. "first
  line of last user message, truncated to 50 chars"), not three radio
  buttons.

What this is **not**:

- An excuse for cryptic UIs. The flexible primitive should be presented
  with a clear placeholder, a working default, and visible feedback (live
  match count, example matches, syntax errors inline). Easy *and*
  flexible — not flexible *instead of* easy.
- Permission to dump raw JSON config files at the user. Surface the
  underlying string/regex/glob in a friendly input; don't make them
  navigate a tree.

When in doubt: which would a teammate prefer when they're trying to do
something the original feature designer didn't anticipate? Ship that.

---

## (room for more principles as we name them)
