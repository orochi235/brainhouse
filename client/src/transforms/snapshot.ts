/**
 * Pure-function Markdown serializer for the inspector's "Copy debug
 * snapshot" button. Format documented in
 * `docs/superpowers/specs/2026-06-08-transforms-3-inspector-trace-design.md`
 * ("Debug snapshot format" section). The output is intended to be
 * pasted into a Claude conversation, so each section is anchored by a
 * stable heading. The `runner: v2` line is the version sentinel — bump
 * it when the format changes shape.
 */

import type { Event } from '@server/parser.ts';
import type { ViewItem } from '../lib/pipeline-types.ts';
import type { Stage2TraceRecord } from './runner.ts';
import type { TraceRecord } from './selectors/types.ts';

export interface SnapshotInput {
  panelId: string;
  event: Event;
  eventIndex: number;
  eventTotal: number;
  capturedAt: Date;
  record: TraceRecord;
  stage2: Stage2TraceRecord[];
  /** All items present after stage-2; the serializer picks the ones
   * whose indices appear in `record.finalItemIndices`. */
  items: ViewItem[];
  toggles: Record<string, boolean>;
  runnerVersion?: string;
}

const CURRENT_RUNNER_VERSION = 'v2 (selector dispatch)';

function tick(yes: boolean): string {
  return yes ? '✓' : ' ';
}

function stage1Table(record: TraceRecord): string {
  const header =
    '| transform | matched | ran | consumed | mutated | error |\n' +
    '|-----------|:-:|:-:|:-:|:-:|:--|';
  const rows = record.perStage.map((s) => {
    const err = s.error ? s.error.message : '';
    return `| ${s.transformKey} | ${tick(s.matched)} | ${tick(s.ran)} | ${tick(s.consumed)} | ${tick(s.mutatedItems)} | ${err} |`;
  });
  return [header, ...rows].join('\n');
}

function stage2Table(stage2: Stage2TraceRecord[]): string {
  if (stage2.length === 0) return '_(no stage-2 transforms ran)_';
  const header =
    '| transform | mutated | beforeLen → afterLen | error |\n' +
    '|-----------|:-:|:-:|:--|';
  const rows = stage2.map((r) => {
    const err = r.error ? r.error.message : '';
    return `| ${r.transformKey} | ${tick(r.mutatedItems)} | ${r.beforeLen} → ${r.afterLen} | ${err} |`;
  });
  return [header, ...rows].join('\n');
}

function disabledList(toggles: Record<string, boolean>): string[] {
  return Object.entries(toggles)
    .filter(([, v]) => v === false)
    .map(([k]) => k);
}

export function serializeDebugSnapshot(input: SnapshotInput): string {
  const {
    panelId,
    event,
    eventIndex,
    eventTotal,
    capturedAt,
    record,
    stage2,
    items,
    toggles,
    runnerVersion = CURRENT_RUNNER_VERSION,
  } = input;

  const captured = capturedAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const finalItems = record.finalItemIndices
    .map((idx) => items[idx])
    .filter((it): it is ViewItem => it !== undefined);

  const disabled = disabledList(toggles);
  const enabled = record.perStage
    .map((s) => s.transformKey)
    .concat(stage2.map((s) => s.transformKey))
    .filter((k, i, a) => a.indexOf(k) === i)
    .filter((k) => toggles[k] !== false);

  const sections: string[] = [];
  sections.push('# brainhouse pipeline snapshot');
  sections.push(
    [
      `panel: \`${panelId}\``,
      `event: \`${event.uuid}\`  (index ${eventIndex} of ${eventTotal})`,
      `captured: ${captured}`,
      `runner: ${runnerVersion}`,
    ].join('\n'),
  );
  sections.push('## Raw event');
  sections.push('```json\n' + JSON.stringify(event, null, 2) + '\n```');
  sections.push('## Stage 1 trace');
  sections.push(stage1Table(record));
  if (disabled.length > 0) {
    sections.push(`(disabled: ${disabled.map((k) => `\`${k}\``).join(', ')})`);
  }
  sections.push('## Stage 2 trace');
  sections.push(stage2Table(stage2));
  sections.push('## Resulting view items');
  sections.push('```json\n' + JSON.stringify(finalItems, null, 2) + '\n```');
  sections.push('## Toggles (panel-local)');
  sections.push(
    [
      `enabled: ${enabled.join(', ') || '(none recorded)'}`,
      `disabled: ${disabled.join(', ') || '(none)'}`,
    ].join('\n'),
  );

  // Trailing newline keeps clipboard pastes well-formed.
  return sections.join('\n\n') + '\n';
}

export function serializeDebugSnapshotJson(input: SnapshotInput): string {
  const finalItems = input.record.finalItemIndices
    .map((idx) => input.items[idx])
    .filter((it): it is ViewItem => it !== undefined);
  const obj = {
    panelId: input.panelId,
    capturedAt: input.capturedAt.toISOString(),
    runnerVersion: input.runnerVersion ?? CURRENT_RUNNER_VERSION,
    event: input.event,
    eventIndex: input.eventIndex,
    eventTotal: input.eventTotal,
    stage1: input.record.perStage,
    stage2: input.stage2,
    finalItems,
    toggles: input.toggles,
  };
  return JSON.stringify(obj, null, 2);
}
