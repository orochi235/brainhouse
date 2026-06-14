/**
 * Confirmation prompt rendered in the lightbox when the user
 * shift-clicks a title-bar × on a session panel or project widget.
 * Adds the given session ids to `prefs.blacklist.sessionIds` and
 * refreshes prefs so the panel disappears immediately.
 */

import { useState } from 'react';
import { trpc } from '../trpc.ts';
import { useLightbox } from '../lib/lightboxContext.ts';
import { usePrefs } from '../lib/usePrefs.tsx';

export function BlacklistConfirm({
  label,
  sessionIds,
}: {
  /** Human-readable description of what's being blacklisted. */
  label: string;
  sessionIds: string[];
}) {
  const { prefs, refetch } = usePrefs();
  const lightbox = useLightbox();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const merged = Array.from(new Set([...prefs.blacklist.sessionIds, ...sessionIds]));
      await trpc.prefs.update.mutate({ blacklist: { sessionIds: merged } });
      await refetch();
      lightbox.close();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="blacklist-confirm">
      <h3 className="lightbox-title">Blacklist {sessionIds.length === 1 ? 'session' : 'sessions'}?</h3>
      <p className="blacklist-confirm-body">
        Hide <strong>{label}</strong> ({sessionIds.length} session
        {sessionIds.length === 1 ? '' : 's'}) from the UI. The server keeps ingesting events;
        removing the entry from Prefs → Blacklist brings it back.
      </p>
      {error && <p className="prefs-error">{error}</p>}
      <div className="blacklist-confirm-actions">
        <button
          type="button"
          className="blacklist-confirm-cancel"
          onClick={() => lightbox.close()}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="blacklist-confirm-go"
          onClick={confirm}
          disabled={busy}
        >
          {busy ? 'Blacklisting…' : 'Blacklist'}
        </button>
      </div>
    </div>
  );
}
