import { describe, expect, it } from 'vitest';
import { aggregateRows, MAX_COLUMN, TAIL_COLUMN } from './flows.js';
import type { EventIndexRow } from './store.js';

function row(overrides: Partial<EventIndexRow> = {}): EventIndexRow {
  return {
    panel_id: 'p1',
    event_uuid: 'u1',
    ts: 0,
    kind: 'assistant_text',
    tool_name: null,
    file_path: null,
    summary: null,
    ...overrides,
  };
}

describe('aggregateRows', () => {
  it('builds (column, type) nodes and consecutive-pair links per session', () => {
    const rows: EventIndexRow[] = [
      row({ event_uuid: 'a', ts: 0, kind: 'user_text' }),
      row({ event_uuid: 'b', ts: 1, kind: 'assistant_text' }),
      row({ event_uuid: 'c', ts: 2, kind: 'tool_use', tool_name: 'Read' }),
    ];
    const g = aggregateRows(rows);
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([
      '0::user_text',
      '1::assistant_text',
      '2::tool_use:Read',
    ]);
    expect(g.links).toHaveLength(2);
    expect(g.links).toContainEqual({
      source: '0::user_text',
      target: '1::assistant_text',
      value: 1,
    });
    expect(g.links).toContainEqual({
      source: '1::assistant_text',
      target: '2::tool_use:Read',
      value: 1,
    });
  });

  it('counts the same transition across multiple sessions', () => {
    const sess = (id: string): EventIndexRow[] => [
      row({ panel_id: id, event_uuid: `${id}-a`, ts: 0, kind: 'user_text' }),
      row({ panel_id: id, event_uuid: `${id}-b`, ts: 1, kind: 'assistant_text' }),
    ];
    const g = aggregateRows([...sess('s1'), ...sess('s2'), ...sess('s3')]);
    const lk = g.links.find(
      (l) => l.source === '0::user_text' && l.target === '1::assistant_text',
    );
    expect(lk?.value).toBe(3);
  });

  it('caps columns and folds late events into a shared tail bucket', () => {
    // 22 events in one session: positions 0..21. Positions 0..19 keep
    // their own columns; positions 20 and 21 collapse into TAIL_COLUMN (20).
    const rows: EventIndexRow[] = [];
    for (let i = 0; i < 22; i++) {
      rows.push(row({ event_uuid: `e${i}`, ts: i, kind: 'assistant_text' }));
    }
    const g = aggregateRows(rows);
    // Distinct columns: 0..19 plus the tail bucket = 21 nodes (all
    // assistant_text since the type is constant).
    expect(g.nodes).toHaveLength(MAX_COLUMN + 2);
    const tail = g.nodes.find((n) => n.column === TAIL_COLUMN);
    expect(tail).toBeDefined();
    expect(tail?.label).toBe('assistant_text');
    // The tail node would self-loop (event 20 → event 21, both same id);
    // aggregateRows skips self-loops so no link lands on tail → tail.
    const tailSelfLoop = g.links.find(
      (l) => l.source === tail?.id && l.target === tail?.id,
    );
    expect(tailSelfLoop).toBeUndefined();
  });

  it('derives subagent:<type> from Task tool_use summary metadata', () => {
    const rows: EventIndexRow[] = [
      row({ event_uuid: 'a', ts: 0, kind: 'user_text' }),
      row({
        event_uuid: 'b',
        ts: 1,
        kind: 'tool_use',
        tool_name: 'Task',
        summary: JSON.stringify({
          tool_use_id: 't1',
          subagent_type: 'Explore',
        }),
      }),
    ];
    const g = aggregateRows(rows);
    const labels = g.nodes.map((n) => n.label).sort();
    expect(labels).toContain('subagent:Explore');
    // No plain `tool_use:Task` — Task collapses into the subagent node.
    expect(labels).not.toContain('tool_use:Task');
  });

  it('resolves tool_result back to its tool name via tool_use_id', () => {
    const rows: EventIndexRow[] = [
      row({
        event_uuid: 'a',
        ts: 0,
        kind: 'tool_use',
        tool_name: 'Bash',
        summary: JSON.stringify({ tool_use_id: 'bash-1' }),
      }),
      row({
        event_uuid: 'b',
        ts: 1,
        kind: 'tool_result',
        summary: JSON.stringify({ tool_use_id: 'bash-1' }),
      }),
    ];
    const g = aggregateRows(rows);
    const labels = g.nodes.map((n) => n.label).sort();
    expect(labels).toContain('tool_use:Bash');
    expect(labels).toContain('tool_result:Bash');
  });

  it('falls back to tool_result:? when no matching tool_use_id was seen', () => {
    const rows: EventIndexRow[] = [
      row({ event_uuid: 'a', ts: 0, kind: 'user_text' }),
      row({ event_uuid: 'b', ts: 1, kind: 'tool_result', summary: null }),
    ];
    const g = aggregateRows(rows);
    expect(g.nodes.map((n) => n.label)).toContain('tool_result:?');
  });
});
