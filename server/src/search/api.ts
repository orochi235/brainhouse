/**
 * Search results as the client sees them: the worker's groups, with the title,
 * liveness and project color each session has everywhere else in brainhouse,
 * so the modal and the panels never disagree.
 */

import type { TranscriptMonitor } from '../monitor.js';
import type { Store } from '../store.js';
import { type PanelTheme, readPanelTheme } from '../theme.js';
import type { SearchGroup, SearchResult } from './search.js';

export interface SearchGroupView extends SearchGroup {
  title: string | null;
  agentType: string | null;
  live: boolean;
  theme: PanelTheme | null;
}

export interface SearchResultView extends Omit<SearchResult, 'groups'> {
  groups: SearchGroupView[];
}

export async function describeGroups(
  result: SearchResult,
  monitor: TranscriptMonitor,
  store: Store | null,
): Promise<SearchResultView> {
  const groups = await Promise.all(
    result.groups.map(async (g): Promise<SearchGroupView> => {
      const panelId = g.agentId ?? g.sessionId;
      const panel = monitor.store.panel(panelId);
      const summary = panel ? null : store?.getSession(panelId);
      return {
        ...g,
        title: panel?.title ?? summary?.title ?? null,
        agentType: panel?.agent_type ?? summary?.agent_type ?? null,
        live: panel?.status === 'live',
        theme: g.cwd ? await readPanelTheme(g.cwd).catch(() => null) : null,
      };
    }),
  );
  return { ...result, groups };
}
