import { describe, it, expect } from 'vitest';
import { processesReducer, initialProcessesState } from './useProcesses.ts';

const baseRow = (over: any = {}) => ({
  process_id: 'p1', host: 'local', pid: 100, ppid: 1, start_ts: 0,
  command: 'node x', cwd: '/p', session_id: 's1',
  hook_command: null, run_in_background: false,
  provenance: 'observed', runtime: 'node', runtime_version: '22.5.0', runtime_source: 'path',
  framework: null, framework_version: null,
  ports: [], ended_ts: null, ended_reason: null, uptime_s: 5,
  ...over,
});

describe('processesReducer', () => {
  it('snapshot replaces state', () => {
    const s = processesReducer(initialProcessesState, { type: 'snapshot', rows: [baseRow()] });
    expect(s.rows.size).toBe(1);
  });
  it('upsert adds/updates', () => {
    let s = processesReducer(initialProcessesState, { type: 'snapshot', rows: [] });
    s = processesReducer(s, { type: 'delta', delta: { op: 'process_upsert', process: baseRow() } });
    expect(s.rows.get('p1')?.runtime).toBe('node');
  });
  it('delete removes', () => {
    let s = processesReducer(initialProcessesState, { type: 'snapshot', rows: [baseRow()] });
    s = processesReducer(s, { type: 'delta', delta: { op: 'process_delete', process_id: 'p1' } });
    expect(s.rows.size).toBe(0);
  });
  it('ports update merges', () => {
    let s = processesReducer(initialProcessesState, { type: 'snapshot', rows: [baseRow()] });
    s = processesReducer(s, { type: 'delta', delta: { op: 'process_ports', process_id: 'p1', ports: [{ proto: 'TCP', addr: '127.0.0.1', port: 5173 }] } });
    expect(s.rows.get('p1')?.ports[0].port).toBe(5173);
  });
});
