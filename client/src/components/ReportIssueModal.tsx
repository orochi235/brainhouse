/**
 * "Report an issue" modal. Describe what looks wrong with a session; the
 * server writes the report to `~/.brainhouse/reports/` and opens an iTerm2
 * window running `claude` in the brainhouse checkout, seeded with it.
 *
 * Design: `docs/superpowers/specs/2026-08-19-report-issue-design.md`.
 */

import { type KeyboardEvent, useState } from 'react';
import { useLightbox } from '../lib/lightboxContext.ts';
import { projectLabel } from '../lib/project.ts';
import { trpc } from '../trpc.ts';
import type { PanelState } from '../useDeltaStream.ts';

export function ReportIssueModal({ panel }: { panel: PanelState }) {
  const lightbox = useLightbox();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOnly, setSavedOnly] = useState<{ path: string; reason?: string } | null>(null);

  const project = projectLabel(panel.cwd, panel.repo_root);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setSavedOnly(null);
    try {
      const res = await trpc.reportIssue.mutate({ panelId: panel.id, text });
      if (res.launched) lightbox.close();
      else setSavedOnly({ path: res.reportPath, reason: res.error });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="report-issue-modal">
      <h3 className="lightbox-title">Report an issue</h3>
      <p className="report-issue-context">
        {panel.title}
        {project && <span className="report-issue-project">{project}</span>}
        <code>{panel.id}</code>
      </p>
      <textarea
        className="report-issue-text"
        // biome-ignore lint/a11y/noAutofocus: the modal exists to be typed into
        autoFocus
        rows={6}
        placeholder="What looks wrong with this session?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Issue description"
      />
      {error && <p className="prefs-error">{error}</p>}
      {savedOnly && (
        <p className="report-issue-saved">
          Report saved to <code>{savedOnly.path}</code>, but no iTerm2 window opened.
          {savedOnly.reason && <> ({savedOnly.reason})</>} Run it yourself with{' '}
          <code>~/.brainhouse/reports/launch.sh &lt;report&gt;</code>.
        </p>
      )}
      <div className="report-issue-actions">
        <button type="button" className="debug-spawn" onClick={() => lightbox.close()}>
          Cancel
        </button>
        <button
          type="button"
          className="debug-spawn"
          disabled={!text.trim() || busy}
          onClick={() => void submit()}
        >
          {busy ? 'reporting…' : 'Report'}
        </button>
      </div>
    </div>
  );
}
