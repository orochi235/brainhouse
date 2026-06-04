import { useEffect, useReducer } from 'react';
import { trpc } from './trpc.ts';

export type ProcessRow = {
  process_id: string; host: 'local';
  pid: number; ppid: number; start_ts: number;
  command: string; cwd: string | null;
  session_id: string | null;
  hook_command: string | null; run_in_background: boolean;
  provenance: 'hooked' | 'observed' | 'heuristic' | 'discovered';
  runtime: string | null; runtime_version: string | null; runtime_source: string | null;
  framework: string | null; framework_version: string | null;
  ports: Array<{ proto: 'TCP'; addr: string; port: number }>;
  ended_ts: number | null; ended_reason: string | null;
  uptime_s: number;
  bash_id: string | null;
};

export type ProcessDelta =
  | { op: 'process_upsert'; process: ProcessRow }
  | { op: 'process_delete'; process_id: string }
  | { op: 'process_ports'; process_id: string; ports: ProcessRow['ports'] };

type State = { rows: Map<string, ProcessRow> };
type Action =
  | { type: 'snapshot'; rows: ProcessRow[] }
  | { type: 'delta'; delta: ProcessDelta };

export const initialProcessesState: State = { rows: new Map() };

export function processesReducer(state: State, action: Action): State {
  if (action.type === 'snapshot') {
    const m = new Map<string, ProcessRow>();
    for (const r of action.rows) m.set(r.process_id, r);
    return { rows: m };
  }
  const m = new Map(state.rows);
  const d = action.delta;
  if (d.op === 'process_upsert') m.set(d.process.process_id, d.process);
  else if (d.op === 'process_delete') m.delete(d.process_id);
  else if (d.op === 'process_ports') {
    const cur = m.get(d.process_id);
    if (cur) m.set(d.process_id, { ...cur, ports: d.ports });
  }
  return { rows: m };
}

export function useProcesses(): ProcessRow[] {
  const [state, dispatch] = useReducer(processesReducer, initialProcessesState);
  useEffect(() => {
    const sub = trpc.processes.subscribe.subscribe(undefined, {
      onData(msg: any) {
        if (msg.kind === 'snapshot') dispatch({ type: 'snapshot', rows: msg.rows });
        else dispatch({ type: 'delta', delta: msg.delta });
      },
    });
    return () => sub.unsubscribe();
  }, []);
  return Array.from(state.rows.values());
}
