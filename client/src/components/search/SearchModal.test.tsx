import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hit = (docId: number, text: string) => ({
  docId,
  eventUuid: `e${docId}`,
  ts: 1_790_000_000 + docId,
  kind: 'user_text' as const,
  tool: null,
  isError: false,
  snippet: text,
  clippedStart: false,
  clippedEnd: false,
  ranges: [[0, 6]] as Array<[number, number]>,
});
const group = (fileId: number, hits: ReturnType<typeof hit>[]) => ({
  fileId,
  sessionId: `session-${fileId}`,
  agentId: null,
  account: 'MSB',
  cwd: '/Users/x/src/brainhouse',
  repoRoot: '/Users/x/src/brainhouse',
  firstTs: 1_790_000_000,
  lastTs: 1_790_000_100,
  latestHitTs: 1_790_000_100,
  hitCount: hits.length,
  hits,
  title: `Session ${fileId}`,
  agentType: null,
  live: false,
  theme: null,
});
const result = {
  groups: [
    group(1, [hit(10, 'needle one'), hit(11, 'needle two')]),
    group(2, [hit(20, 'needle three')]),
  ],
  totalSessions: 2,
  totalHits: 3,
  nextCursor: null,
  partial: null,
  tooBroad: false,
  errors: [],
  highlight: { terms: ['needle'], regex: null },
  elapsedMs: 4,
};

vi.mock('../../trpc.ts', () => ({
  trpc: {
    search: {
      query: { query: vi.fn(async () => result) },
      status: { query: vi.fn(async () => ({ files: 2, docs: 3, pending: 0, building: false })) },
      transcript: {
        query: vi.fn(async ({ fileId }: { fileId: number }) => ({
          fileId,
          path: `/t/${fileId}.jsonl`,
          sessionId: `session-${fileId}`,
          agentId: null,
          cwd: '/Users/x/src/brainhouse',
          docs: result.groups
            .find((g) => g.fileId === fileId)
            ?.hits.map((h) => ({
              id: h.docId,
              eventUuid: h.eventUuid,
              ts: h.ts,
              kind: h.kind,
              tool: null,
              isError: false,
              text: h.snippet,
              truncated: 0,
              ranges: h.ranges,
            })),
        })),
      },
      docText: { query: vi.fn() },
    },
  },
}));

import { SearchModal, toggleToken } from './SearchModal.tsx';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
});

async function renderWithResults() {
  render(<SearchModal initialQuery="needle" />);
  await screen.findByText('Session 1');
  return screen.getByRole('combobox');
}

const selectedText = () => screen.getByRole('option', { selected: true }).textContent;

describe('<SearchModal>', () => {
  it('selects the first hit when results arrive', async () => {
    await renderWithResults();
    expect(selectedText()).toContain('needle one');
  });

  it('moves through hits and across sessions with the arrow keys', async () => {
    const input = await renderWithResults();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(selectedText()).toContain('needle two');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(selectedText()).toContain('needle three');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(selectedText()).toContain('needle three');
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(selectedText()).toContain('needle one');
  });

  it('shows the selected hit in the reader', async () => {
    const input = await renderWithResults();
    await waitFor(() =>
      expect(document.querySelector('.search-doc.is-current')?.textContent).toContain('needle one'),
    );
    fireEvent.keyDown(input, { key: 'ArrowDown', shiftKey: true });
    await waitFor(() =>
      expect(document.querySelector('.search-doc.is-current')?.textContent).toContain(
        'needle three',
      ),
    );
  });

  it('steps between matches in the reader with n and N, and leaves it with Esc', async () => {
    const input = await renderWithResults();
    fireEvent.keyDown(input, { key: 'Enter' });
    const reader = screen.getByLabelText('Transcript');
    await waitFor(() => expect(reader.querySelectorAll('.search-doc')).toHaveLength(2));
    expect(document.activeElement).toBe(reader);
    act(() => {
      fireEvent.keyDown(reader, { key: 'n' });
    });
    expect(reader.querySelector('.search-doc.is-current')?.textContent).toContain('needle two');
    act(() => {
      fireEvent.keyDown(reader, { key: 'N', shiftKey: true });
    });
    expect(reader.querySelector('.search-doc.is-current')?.textContent).toContain('needle one');
    fireEvent.keyDown(reader, { key: 'Escape' });
    expect(document.activeElement).toBe(input);
  });

  it('toggles a role chip into and out of the query', async () => {
    const input = (await renderWithResults()) as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: 'out' }));
    expect(input.value).toBe('needle role:out');
    fireEvent.click(screen.getByRole('button', { name: 'out' }));
    expect(input.value).toBe('needle');
  });
});

describe('toggleToken', () => {
  it('adds a missing token and removes a present one, ignoring case', () => {
    expect(toggleToken('a b', 'role:out')).toBe('a b role:out');
    expect(toggleToken('a ROLE:out b', 'role:out')).toBe('a b');
  });
});
