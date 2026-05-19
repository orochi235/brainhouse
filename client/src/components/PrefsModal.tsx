/**
 * macOS-System-Preferences-style multi-panel editor. Left rail lists
 * sections; right pane shows the active section. Lives inside the lightbox
 * so it inherits backdrop + Esc dismissal.
 *
 * Wire-up:
 *   - on open, fetch prefs.get() and seed local draft state
 *   - edits stay in draft; "Save" pushes the whole draft via prefs.update()
 *   - server validates against Zod schema + persists atomically
 */

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { trpc } from '../trpc.ts';

type Root = { path: string; label?: string; color?: string };
type SectionKey = 'accounts' | 'display' | 'messages' | 'lifecycle' | 'workspace' | 'trash';

interface PrefsDraft {
  roots: Root[];
  display: {
    imessage: boolean;
    showElapsed: boolean;
    conversation: boolean;
  };
  messages: {
    thinking: boolean;
    system: boolean;
    meta: boolean;
    tools: boolean;
    fileChanges: boolean;
    opStrips: boolean;
  };
  timings: {
    idleSeconds: number;
    miniSeconds: number;
    removeAfterSeconds: number;
    tickIntervalMs: number;
  };
  workspace: {
    minCols: number;
    minRows: number;
    maxTileSpan: number;
    spawnSubagentsMinimized: boolean;
  };
}

const SECTIONS: { key: SectionKey; icon: string; label: string }[] = [
  { key: 'accounts', icon: '◉', label: 'Accounts' },
  { key: 'display', icon: '◐', label: 'Display' },
  { key: 'messages', icon: '◇', label: 'Messages' },
  { key: 'lifecycle', icon: '◷', label: 'Lifecycle' },
  { key: 'workspace', icon: '▦', label: 'Workspace' },
  { key: 'trash', icon: '🗑', label: 'Trash' },
];

export function PrefsModal({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState<PrefsDraft | null>(null);
  const [active, setActive] = useState<SectionKey>('accounts');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    trpc.prefs.get.query().then((p) => {
      if (cancelled) return;
      setDraft(p as PrefsDraft);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!draft) return <p className="prefs-loading">Loading prefs…</p>;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await trpc.prefs.update.mutate(draft);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="prefs-modal">
      <h3 className="lightbox-title">preferences</h3>
      <div className="prefs-body">
        <nav className="prefs-rail" aria-label="Preference sections">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`prefs-rail-item ${active === s.key ? 'active' : ''}`}
              onClick={() => setActive(s.key)}
              aria-pressed={active === s.key}
            >
              <span className="prefs-rail-icon" aria-hidden="true">
                {s.icon}
              </span>
              <span>{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="prefs-pane">
          {active === 'accounts' && <AccountsSection draft={draft} setDraft={setDraft} />}
          {active === 'display' && <DisplaySection draft={draft} setDraft={setDraft} />}
          {active === 'messages' && <MessagesSection draft={draft} setDraft={setDraft} />}
          {active === 'lifecycle' && <LifecycleSection draft={draft} setDraft={setDraft} />}
          {active === 'workspace' && <WorkspaceSection draft={draft} setDraft={setDraft} />}
          {active === 'trash' && <TrashSection />}
        </div>
      </div>
      {error && <p className="prefs-error">{error}</p>}
      <div className="prefs-actions">
        <button type="button" className="prefs-cancel" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="prefs-save" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

interface SectionProps {
  draft: PrefsDraft;
  setDraft: (d: PrefsDraft) => void;
}

function AccountsSection({ draft, setDraft }: SectionProps) {
  return (
    <Section
      title="Accounts"
      hint={
        <>
          Directories the watcher monitors. Empty falls back to <code>~/.claude/projects</code> and{' '}
          <code>~/.claude-pw/projects</code>.
        </>
      }
    >
      {draft.roots.map((r, i) => (
        <div className="prefs-root-row" key={i}>
          <input
            type="text"
            placeholder="/path/to/projects"
            value={r.path}
            onChange={(e) => {
              const roots = draft.roots.slice();
              roots[i] = { ...roots[i], path: e.target.value } as Root;
              setDraft({ ...draft, roots });
            }}
          />
          <input
            type="text"
            placeholder="label (optional)"
            value={r.label ?? ''}
            onChange={(e) => {
              const roots = draft.roots.slice();
              roots[i] = { ...roots[i], label: e.target.value || undefined } as Root;
              setDraft({ ...draft, roots });
            }}
          />
          <button
            type="button"
            className="prefs-remove"
            onClick={() => {
              const roots = draft.roots.slice();
              roots.splice(i, 1);
              setDraft({ ...draft, roots });
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="prefs-add"
        onClick={() => setDraft({ ...draft, roots: [...draft.roots, { path: '' }] })}
      >
        + add account
      </button>
    </Section>
  );
}

function DisplaySection({ draft, setDraft }: SectionProps) {
  const set = (patch: Partial<PrefsDraft['display']>) =>
    setDraft({ ...draft, display: { ...draft.display, ...patch } });
  return (
    <Section title="Display" hint="How messages render — style and format.">
      <CheckboxField
        label="iMessage bubble style"
        checked={draft.display.imessage}
        onChange={(v) => set({ imessage: v })}
      />
      <CheckboxField
        label="Show elapsed time (vs clock)"
        checked={draft.display.showElapsed}
        onChange={(v) => set({ showElapsed: v })}
      />
      <CheckboxField
        label="Conversation view"
        checked={draft.display.conversation}
        onChange={(v) => set({ conversation: v })}
      />
    </Section>
  );
}

function MessagesSection({ draft, setDraft }: SectionProps) {
  const set = (patch: Partial<PrefsDraft['messages']>) =>
    setDraft({ ...draft, messages: { ...draft.messages, ...patch } });
  return (
    <Section
      title="Messages"
      hint="Which kinds of view-items appear in the transcript. User and assistant bubbles are always visible."
    >
      <CheckboxField
        label="Tool calls"
        checked={draft.messages.tools}
        onChange={(v) => set({ tools: v })}
      />
      <CheckboxField
        label="File-change rows"
        checked={draft.messages.fileChanges}
        onChange={(v) => set({ fileChanges: v })}
      />
      <CheckboxField
        label="Between-chat op strips"
        checked={draft.messages.opStrips}
        onChange={(v) => set({ opStrips: v })}
      />
      <CheckboxField
        label="Thinking blocks"
        checked={draft.messages.thinking}
        onChange={(v) => set({ thinking: v })}
      />
      <CheckboxField
        label="System events"
        checked={draft.messages.system}
        onChange={(v) => set({ system: v })}
      />
      <CheckboxField
        label="Meta events"
        checked={draft.messages.meta}
        onChange={(v) => set({ meta: v })}
      />
    </Section>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="prefs-field prefs-checkbox-field">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function LifecycleSection({ draft, setDraft }: SectionProps) {
  const set = (patch: Partial<PrefsDraft['timings']>) =>
    setDraft({ ...draft, timings: { ...draft.timings, ...patch } });
  return (
    <Section
      title="Lifecycle"
      hint="How long each session lingers before the server demotes or forgets it."
    >
      <NumberField
        label="Idle → done (seconds)"
        value={draft.timings.idleSeconds}
        onChange={(v) => set({ idleSeconds: v })}
      />
      <NumberField
        label="Done → mini (seconds)"
        value={draft.timings.miniSeconds}
        onChange={(v) => set({ miniSeconds: v })}
      />
      <NumberField
        label="Mini → removed (seconds)"
        value={draft.timings.removeAfterSeconds}
        onChange={(v) => set({ removeAfterSeconds: v })}
      />
      <NumberField
        label="Lifecycle tick (ms)"
        value={draft.timings.tickIntervalMs}
        onChange={(v) => set({ tickIntervalMs: v })}
      />
    </Section>
  );
}

function WorkspaceSection({ draft, setDraft }: SectionProps) {
  const set = (patch: Partial<PrefsDraft['workspace']>) =>
    setDraft({ ...draft, workspace: { ...draft.workspace, ...patch } });
  return (
    <Section title="Workspace" hint="How the session grid tiles itself across the viewport.">
      <NumberField
        label="Minimum columns"
        value={draft.workspace.minCols}
        min={1}
        onChange={(v) => set({ minCols: v })}
      />
      <NumberField
        label="Minimum rows"
        value={draft.workspace.minRows}
        min={1}
        onChange={(v) => set({ minRows: v })}
      />
      <NumberField
        label="Max tile size (grid units, 0 = uncapped)"
        value={draft.workspace.maxTileSpan}
        min={0}
        onChange={(v) => set({ maxTileSpan: v })}
      />
      <CheckboxField
        label="Spawn subsessions minimized"
        checked={draft.workspace.spawnSubagentsMinimized}
        onChange={(v) => set({ spawnSubagentsMinimized: v })}
      />
    </Section>
  );
}

interface BinnedPanel {
  id: string;
  title: string;
  cwd: string | null;
  account_label: string | null;
  binned_at: number | null;
}

/** Trash bin viewer. Independent of `draft` because the bin lives entirely
 * server-side; we fetch on mount and again after each restore/purge. */
function TrashSection() {
  const [items, setItems] = useState<BinnedPanel[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await trpc.bin.list.query();
    setItems(res.panels as BinnedPanel[]);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const restore = async (id: string) => {
    setBusy(id);
    try {
      await trpc.bin.restore.mutate({ panelId: id });
      await refresh();
    } finally {
      setBusy(null);
    }
  };
  const purge = async (id: string) => {
    setBusy(id);
    try {
      await trpc.bin.purge.mutate({ panelId: id });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title="Trash"
      hint="Sessions you've sent to the trash with the 🗑 button. Restore one to bring it back into the dock; purge to permanently forget it."
    >
      {items.length === 0 && <p className="prefs-hint">The trash is empty.</p>}
      {items.map((p) => (
        <div className="prefs-trash-row" key={p.id}>
          <div className="prefs-trash-meta">
            <span className="prefs-trash-title">{p.title}</span>
            {p.cwd && <span className="prefs-trash-cwd">{p.cwd}</span>}
            {p.binned_at && (
              <span className="prefs-trash-when">
                trashed {new Date(p.binned_at * 1000).toLocaleString()}
              </span>
            )}
          </div>
          <div className="prefs-trash-actions">
            <button
              type="button"
              className="prefs-add"
              disabled={busy === p.id}
              onClick={() => void restore(p.id)}
            >
              Restore
            </button>
            <button
              type="button"
              className="prefs-remove prefs-trash-purge"
              disabled={busy === p.id}
              onClick={() => void purge(p.id)}
            >
              Purge
            </button>
          </div>
        </div>
      ))}
    </Section>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="prefs-section">
      <h4>{title}</h4>
      {hint && <p className="prefs-hint">{hint}</p>}
      {children}
    </section>
  );
}

function NumberField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="prefs-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onChange(n);
        }}
      />
    </label>
  );
}
