import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { LightboxContext, type LightboxState, type LightboxTheme } from './lightboxContext.ts';

// This module must export components only (no hooks, no context objects)
// so Vite can Fast Refresh it in isolation — see the note on
// LightboxContext in lightboxContext.ts. `useLightbox` lives there.

interface Entry {
  content: ReactNode;
  variant: 'rich' | 'text';
  theme: LightboxTheme | null;
}

export function LightboxProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeGuardRef = useRef<(() => boolean) | null>(null);
  // Navigation stack: opening while already open pushes, so drilling
  // into a detail view (session → tool result) keeps the containing
  // view underneath. `back()` pops one level; the dialog only closes
  // for real from the root entry.
  const [entries, setEntries] = useState<Entry[]>([]);
  const entriesRef = useRef<Entry[]>(entries);
  entriesRef.current = entries;
  const top = entries[entries.length - 1] ?? null;
  const canGoBack = entries.length > 1;

  const setCloseGuard = useCallback<LightboxState['setCloseGuard']>((g) => {
    closeGuardRef.current = g;
  }, []);

  const tryClose = useCallback(() => {
    const guard = closeGuardRef.current;
    if (guard && !guard()) return;
    dialogRef.current?.close();
  }, []);

  // Pop one level; from the root, closes. The guard gates leaving the
  // current content either way.
  const back = useCallback(() => {
    const guard = closeGuardRef.current;
    if (guard && !guard()) return;
    if (entriesRef.current.length > 1) {
      closeGuardRef.current = null;
      setEntries((prev) => prev.slice(0, -1));
    } else {
      dialogRef.current?.close();
    }
  }, []);

  const open = useCallback<LightboxState['open']>((c, opts) => {
    // Clear any guard left behind by a previously-mounted modal.
    closeGuardRef.current = null;
    const entry: Entry = {
      content: c,
      variant: opts?.variant ?? 'rich',
      theme: opts?.theme ?? null,
    };
    const d = dialogRef.current;
    // showModal() throws InvalidStateError if the dialog is already open —
    // which silently breaks "click a different message while lightbox is up."
    // In that case the new content is pushed onto the stack instead.
    if (d?.open) {
      setEntries((prev) => [...prev, entry]);
    } else {
      setEntries([entry]);
      d?.showModal();
    }
  }, []);
  const close = useCallback(() => dialogRef.current?.close(), []);

  // Apply the top entry's .hued theme to the dialog. Clearing matters
  // too — popping back from an unthemed detail view must restore the
  // parent's theme, and a themed open must not leak into a plain one.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (top?.theme) {
      d.style.setProperty('--panel-theme-bg', top.theme.background);
      d.style.setProperty('--panel-theme-fg', top.theme.foreground);
      d.classList.add('has-theme');
    } else {
      d.style.removeProperty('--panel-theme-bg');
      d.style.removeProperty('--panel-theme-fg');
      d.classList.remove('has-theme');
    }
  }, [top]);

  // Backdrop click closes (click outside the inner box).
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    const handler = (e: MouseEvent) => {
      // Keyboard activation (Space/Enter on a focused control) fires a
      // click with detail 0 at (0,0) — outside any rect. Only pointer
      // clicks count as backdrop clicks.
      if (e.detail === 0) return;
      const box = d.querySelector<HTMLElement>('.lightbox-inner');
      if (!box) return;
      const r = box.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        tryClose();
      }
    };
    d.addEventListener('click', handler);
    // Esc fires the dialog's `cancel` event before the implicit close.
    // With stacked entries, Esc zooms out one level instead of closing;
    // preventDefault() suppresses the native close in both the pop case
    // and the guard-blocked case.
    const cancel = (e: Event) => {
      const guard = closeGuardRef.current;
      if (guard && !guard()) {
        e.preventDefault();
        return;
      }
      if (entriesRef.current.length > 1) {
        e.preventDefault();
        closeGuardRef.current = null;
        setEntries((prev) => prev.slice(0, -1));
      }
    };
    d.addEventListener('cancel', cancel);
    // Any real close (Esc at root, backdrop, ✕, programmatic) drops the
    // stack so the next open starts fresh.
    const onClose = () => {
      closeGuardRef.current = null;
      setEntries([]);
    };
    d.addEventListener('close', onClose);
    return () => {
      d.removeEventListener('click', handler);
      d.removeEventListener('cancel', cancel);
      d.removeEventListener('close', onClose);
    };
  }, [tryClose]);

  return (
    <LightboxContext.Provider value={{ open, close, setCloseGuard }}>
      {children}
      <dialog ref={dialogRef} className={`lightbox lightbox-${top?.variant ?? 'rich'}`}>
        {canGoBack && (
          <button
            type="button"
            className="lightbox-back"
            onClick={back}
            aria-label="Back"
            title="Back (Esc)"
          >
            ←
          </button>
        )}
        <button type="button" className="lightbox-close" onClick={tryClose} aria-label="Close">
          ×
        </button>
        <div className="lightbox-inner">{top?.content}</div>
      </dialog>
    </LightboxContext.Provider>
  );
}
