# Question tagger: an LLM pass that finds the questions in a session

**Date:** 2026-08-27
**Status:** Approved, not started

## What this is

A second out-of-band model pass, alongside the auto-titler, that labels
user turns as **question**, **directive**, or **control**, so a planned
HUD mode can show "the questions actually asked in this project."

Reader: whoever implements it. Assumes familiarity with
`server/src/titler.ts`, which this deliberately mirrors.

## Why a model, and not a rule

Measured over 280 real human user turns from `~/.claude-msb/projects`
(2026-08-26). Both cheap signals fail:

**Punctuation is a coin flip.** Only 17.5% of turns end in `?`, and
roughly half of those are directives — "can we instead have steps
support `{ estimate: Number }`?", "can you show me?". Meanwhile "do it",
"push", "fix the todo" are directives carrying no `?` at all. 11.7% of
non-`?` turns open with an interrogative word, and most of those are
still directives.

**"Did the reply use tools?" also fails**, which is less obvious and
worth recording so nobody re-derives it: only 14% of `?`-terminated
turns got a tool-free reply, because answering a question *about the
codebase* requires reads. "what's on the todo list?" is
indistinguishable from a directive by that measure.

## Do not make the model tag its own turns

The obvious cheap design — a `UserPromptSubmit` hook instructing the
live session to emit an invisible marker — was already built here, for
titles, and then removed. `titler.ts`'s own header records why: the
`<!-- bh-title: … -->` marker rendered literally in the user's CLI
session, "a visible seam in what's pitched as seamless instrumentation."
The same seam would appear here. Tag out of band, from transcript state
the server already ingests.

## Architecture

`server/src/questionTagger.ts`, structurally a sibling of `titler.ts`:

- Same client acquisition: `ANTHROPIC_API_KEY` when present, else the
  `claude -p` CLI fallback (`titlerCli.ts`). Same permanent-disable and
  single-flight guards.
- Same trigger surface. `monitor.ts` already calls
  `titler.scheduleEvaluation(sid, reason)` at four sites (`stop`,
  `subagent_start`, `user_text`, `assistant_text`); the tagger hangs off
  the same calls. `stop` is the natural reason to fire on — a turn is
  over and its answer is known.
- Same usage accounting: `persistStore.recordTitlerUsage` has a shape to
  copy for cost tracking.
- Model: `claude-haiku-4-5`, as the titler uses.

Differences that matter:

**It is per-turn, not per-panel.** The titler emits one evolving value
for a session; this emits a label per user turn and must not re-ask
about turns it has already labeled. Persist labels keyed by event id and
only send unlabeled turns.

**It needs a backfill path.** The interesting corpus is the ~2700
existing transcripts, not just new turns. Build the batch pass first —
it is also how you iterate on the prompt without waiting for live
sessions.

## The taxonomy

Three buckets, not two. A binary forces the largest category somewhere
wrong: **34% of user turns are ≤25 characters** and are approvals or
answers — `go`, `y`, `2`, `1 then 2`, `yes to all`. Those are *control*,
not directives and not questions.

Label a **span**, not a turn. Turns are genuinely mixed — "commit. then
what?" is a directive and a question in one message — and a turn-level
label throws away the half the HUD wants.

## The half that needs no model

`AskUserQuestion` appears **217 times across 200 transcripts**, already
fully structured with question text and options, and
`client/src/transforms/builtIn/askUserQuestion.ts` already parses it.
Those are the questions *Claude asked Mike* — the decisions he was
consulted on. If the HUD's question log includes both directions, that
half ships today with no inference at all, and it is the better first
increment: it makes the HUD real while the classifier is still being
tuned.

## Build order

1. Extract the `AskUserQuestion` log from existing transcripts. No model.
2. Batch backfill classifier over `~/.claude-msb/projects`, writing
   labels to disk. Iterate the prompt against it; hand-score a sample of
   ~100 turns as the accuracy bar.
3. `questionTagger.ts` live, wired to the existing `monitor.ts` triggers.
4. HUD surface.

## Open

- **Where labels live.** SQLite alongside the panel store is the obvious
  home, but the schema is not designed. Needs to survive a transcript
  re-ingest without re-billing.
- **Whether "question" is even the right axis for the HUD.** Mike's
  stated want is "the actual questions that get asked in each project" —
  it is worth checking against the backfill output in step 2 whether
  what he actually wants is *unresolved* questions, which is a different
  and harder predicate.
