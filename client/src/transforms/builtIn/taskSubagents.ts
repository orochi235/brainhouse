/**
 * Tracks subagents this panel spawned via the `Task` tool. Watches every
 * Task tool_use + its matching tool_result and records a single entry per
 * spawn in `ctx.scratch.subagentSpawns`.
 *
 * Pass-through: never consumes the event. The Task tool capsule still
 * renders in the body (clicking it opens the lightbox with the full
 * prompt). The aggregated view sits in a separate pinned section above
 * the body, joined to the live child panel by the parent.
 */

import type { SubagentSpawn } from '../../lib/pipeline-types.ts';
import type { Stage1Transform } from '../types.ts';

interface TaskInput {
  description?: unknown;
  subagent_type?: unknown;
}

export const taskSubagents: Stage1Transform = {
  kind: 'view',
  stage: 1,
  key: 'built-in.task-subagents',
  name: 'Task → subagent spawn list',
  description:
    'Watches Task tool_use + tool_result pairs and accumulates a list of spawned subagents for the parent panel header.',
  matches: ['tool-use.task', 'tool-result.any'],
  run(event, _items, ctx) {
    if (event.kind === 'tool_use' && event.payload.name === 'Task') {
      const input = (event.payload.input ?? {}) as TaskInput;
      const description = typeof input.description === 'string' ? input.description.trim() : '';
      const agentType =
        typeof input.subagent_type === 'string' && input.subagent_type.trim().length > 0
          ? input.subagent_type.trim()
          : null;
      // Skip Task calls with no description — nothing useful to render.
      if (!description) return false;
      ctx.scratch.subagentSpawns.push({
        toolUseId: event.payload.tool_use_id,
        description,
        agentType,
        status: 'running',
        order: ctx.scratch.subagentSpawns.length,
      });
      return false;
    }
    if (event.kind === 'tool_result') {
      const spawn = findSpawn(ctx.scratch.subagentSpawns, event.payload.tool_use_id);
      if (spawn && spawn.status === 'running') {
        spawn.status = event.payload.is_error ? 'failed' : 'done';
      }
      return false;
    }
    return false;
  },
};

function findSpawn(list: SubagentSpawn[], id: string): SubagentSpawn | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.toolUseId === id) return list[i];
  return undefined;
}
