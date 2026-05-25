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

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_EDITOR_TEMPLATE,
  EDITOR_PRESETS,
  editorPresetIdForTemplate,
} from '../lib/filenameLinks.ts';
import { useLightbox } from '../lib/lightbox.tsx';
import { trpc } from '../trpc.ts';

type Root = { path: string; label?: string; color?: string };
type SectionKey =
  | 'accounts'
  | 'display'
  | 'messages'
  | 'lifecycle'
  | 'workspace'
  | 'editor'
  | 'storage'
  | 'debug'
  | 'trash';

interface PrefsDraft {
  roots: Root[];
  display: {
    imessage: boolean;
    showElapsed: boolean;
    conversation: boolean;
    idleOpacity: number;
    huedHeaderStrength: number;
    toolPaletteDisplay: 'hover' | 'always';
    showSessionTime: boolean;
    showTokens: boolean;
    showContext: boolean;
    autoTitle: boolean;
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
    autoMinimizeOnClear: boolean;
    groupByWorktree: boolean;
    slotCount: number;
  };
  storage: {
    persistEnabled: boolean;
    eventsIndexRetentionDays: number;
  };
  editor: {
    urlTemplate: string;
  };
  debug: {
    enabled: boolean;
  };
}

const SECTIONS: { key: SectionKey; icon: string; label: string }[] = [
  { key: 'accounts', icon: '◉', label: 'Accounts' },
  { key: 'display', icon: '◐', label: 'Display' },
  { key: 'messages', icon: '◇', label: 'Messages' },
  { key: 'lifecycle', icon: '◷', label: 'Lifecycle' },
  { key: 'workspace', icon: '▦', label: 'Workspace' },
  { key: 'editor', icon: '↗', label: 'Editor' },
  { key: 'storage', icon: '◫', label: 'Storage' },
  { key: 'debug', icon: '⌬', label: 'Debug' },
  { key: 'trash', icon: '🗑', label: 'Trash' },
];

export function PrefsModal({ initial, onClose }: { initial: PrefsDraft; onClose: () => void }) {
  // Seeded synchronously from App's cached prefs — no fetch on mount, no
  // "Loading prefs…" flash. The cache is already kept fresh by usePrefs.
  const [draft, setDraft] = useState<PrefsDraft>(initial);
  const [active, setActive] = useState<SectionKey>('accounts');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bounce, setBounce] = useState(false);
  const { setCloseGuard } = useLightbox();

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);

  // While dirty, intercept Esc / backdrop / × so the user has to make an
  // explicit choice (save or revert) rather than silently losing edits.
  // The footer also swaps to a Save/Revert pair when dirty, so there's no
  // close affordance that does the wrong thing.
  useEffect(() => {
    if (!dirty) {
      setCloseGuard(null);
      return;
    }
    setCloseGuard(() => {
      setBounce(true);
      window.setTimeout(() => setBounce(false), 400);
      return false;
    });
    return () => setCloseGuard(null);
  }, [dirty, setCloseGuard]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await trpc.prefs.update.mutate(draft);
      setCloseGuard(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revert = () => setDraft(initial);

  return (
    <div className={`prefs-modal${bounce ? ' bounce' : ''}`}>
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
          {active === 'editor' && <EditorSection draft={draft} setDraft={setDraft} />}
          {active === 'storage' && <StorageSection draft={draft} setDraft={setDraft} />}
          {active === 'debug' && <DebugSection draft={draft} setDraft={setDraft} />}
          {active === 'trash' && <TrashSection />}
        </div>
      </div>
      {error && <p className="prefs-error">{error}</p>}
      <div className="prefs-actions">
        {dirty ? (
          <>
            <span className="prefs-dirty-note">Unsaved changes — save or revert to close.</span>
            <button type="button" className="prefs-cancel" onClick={revert} disabled={busy}>
              Revert
            </button>
            <button type="button" className="prefs-save" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <button type="button" className="prefs-cancel" onClick={onClose} disabled={busy}>
            Close
          </button>
        )}
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
          Directories the watcher monitors. Empty falls back to <code>~/.claude/projects</code>.
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
          <input
            type="color"
            title="Account color — tints the panel badge and border"
            value={r.color ?? '#a78bfa'}
            onChange={(e) => {
              const roots = draft.roots.slice();
              roots[i] = { ...roots[i], color: e.target.value } as Root;
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
      <SliderField
        label="Ended panel opacity"
        hint="How visible explicitly-ended panels stay (e.g. finished subagents). Idle panels are never dimmed. 100% = no fade; floor 20%."
        value={draft.display.idleOpacity}
        onChange={(v) => set({ idleOpacity: v })}
        min={0.2}
        max={1}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <SliderField
        label="Title-bar tint strength"
        hint="How strongly each project's color washes the panel title bar. 0% = no tint; 100% = the title bar is the project color."
        value={draft.display.huedHeaderStrength}
        onChange={(v) => set({ huedHeaderStrength: v })}
        min={0}
        max={1}
        step={0.02}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <label className="prefs-field prefs-select-field">
        <span className="prefs-slider-label">Tool palette</span>
        <span className="prefs-hint">
          Where the floating session tools (pin, lightbox, debug, ×) appear on live panels. Hover
          keeps the panel clean; Always pins the palette visible.
        </span>
        <select
          value={draft.display.toolPaletteDisplay}
          onChange={(e) => set({ toolPaletteDisplay: e.currentTarget.value as 'hover' | 'always' })}
        >
          <option value="hover">Hover</option>
          <option value="always">Always</option>
        </select>
      </label>
      <CheckboxField
        label="Show session-time badge"
        checked={draft.display.showSessionTime}
        onChange={(v) => set({ showSessionTime: v })}
      />
      <CheckboxField
        label="Show token-usage badge"
        checked={draft.display.showTokens}
        onChange={(v) => set({ showTokens: v })}
      />
      <CheckboxField
        label="Show context-size badge"
        checked={draft.display.showContext}
        onChange={(v) => set({ showContext: v })}
      />
      <CheckboxField
        label="Keep panel titles up to date"
        hint="After each assistant turn, a background Stop hook runs `claude -p` on your own CLI auth to propose a panel title. Only fires when the panel is still using its short-id placeholder, or every 20 turns to check for drift. The model self-vetoes with KEEP when the current title still fits, so most calls are a no-op."
        checked={draft.display.autoTitle}
        onChange={(v) => set({ autoTitle: v })}
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

function SliderField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  format,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
}) {
  return (
    <label className="prefs-field prefs-slider-field">
      <span className="prefs-slider-label">
        {label}
        <span className="prefs-slider-value">{format ? format(value) : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <span className="prefs-hint">{hint}</span>}
    </label>
  );
}

function CheckboxField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="prefs-field prefs-checkbox-field">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {hint && <span className="prefs-hint">{hint}</span>}
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
      <CheckboxField
        label="Auto-minimize on /clear or /compact"
        checked={draft.workspace.autoMinimizeOnClear}
        onChange={(v) => set({ autoMinimizeOnClear: v })}
      />
      <CheckboxField
        label="Group panels by worktree"
        checked={draft.workspace.groupByWorktree}
        onChange={(v) => set({ groupByWorktree: v })}
      />
      <NumberField
        label="Guaranteed grid slots (0 disables the allocator)"
        value={draft.workspace.slotCount}
        min={0}
        onChange={(v) => set({ slotCount: v })}
      />
    </Section>
  );
}

function EditorSection({ draft, setDraft }: SectionProps) {
  const template = draft.editor.urlTemplate;
  const presetId = editorPresetIdForTemplate(template);
  const setTemplate = (t: string) => setDraft({ ...draft, editor: { urlTemplate: t } });
  const onPresetChange = (id: string) => {
    if (id === 'custom') {
      // Leave the current template alone; the user will edit it below.
      return;
    }
    const hit = EDITOR_PRESETS.find((p) => p.id === id);
    if (hit) setTemplate(hit.template);
  };
  return (
    <Section
      title="Editor"
      hint={
        <>
          Where filename links open. The template uses{' '}
          <code className="inline-code">{'{path}'}</code>,{' '}
          <code className="inline-code">{'{line}'}</code>, and{' '}
          <code className="inline-code">{'{col}'}</code> placeholders.{' '}
          <code className="inline-code">{'{path}'}</code> is URL-encoded. Pick a preset or write
          your own URL scheme — anything your OS will hand to an installed editor.
        </>
      }
    >
      <label className="prefs-field">
        <span>Editor</span>
        <select value={presetId} onChange={(e) => onPresetChange(e.target.value)}>
          {EDITOR_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </label>
      <label className="prefs-field">
        <span>URL template</span>
        <input
          type="text"
          spellCheck={false}
          value={template}
          placeholder={DEFAULT_EDITOR_TEMPLATE}
          onChange={(e) => setTemplate(e.target.value)}
        />
        <span className="prefs-hint">
          Empty disables editor deeplinks (paths render as plain text).
        </span>
      </label>
    </Section>
  );
}

function StorageSection({ draft, setDraft }: SectionProps) {
  const set = (patch: Partial<PrefsDraft['storage']>) =>
    setDraft({ ...draft, storage: { ...draft.storage, ...patch } });
  return (
    <Section
      title="Storage"
      hint="Brainhouse persists panel state + per-event index to a local SQLite db so a restart resumes instantly. The events index is windowed; session summaries are forever."
    >
      <CheckboxField
        label="Persist session model to disk"
        checked={draft.storage.persistEnabled}
        onChange={(v) => set({ persistEnabled: v })}
      />
      <NumberField
        label="Per-event detail retention (days)"
        hint="Older events get dropped from the events_index table. Session summaries persist forever regardless."
        value={draft.storage.eventsIndexRetentionDays}
        min={1}
        onChange={(v) => set({ eventsIndexRetentionDays: v })}
      />
    </Section>
  );
}

function DebugSection({ draft, setDraft }: SectionProps) {
  const set = (patch: Partial<PrefsDraft['debug']>) =>
    setDraft({ ...draft, debug: { ...draft.debug, ...patch } });
  return (
    <Section
      title="Debug"
      hint="Reveal dev affordances in the UI — extra toolbar buttons (spawn mock subagents, preview animations), scenario picker, etc. Leave off in normal use."
    >
      <CheckboxField
        label="Debug mode"
        checked={draft.debug.enabled}
        onChange={(v) => set({ enabled: v })}
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
  hint,
  value,
  min,
  onChange,
}: {
  label: string;
  hint?: string;
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
      {hint && <span className="prefs-hint">{hint}</span>}
    </label>
  );
}
