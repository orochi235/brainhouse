import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { LightboxContext, type LightboxState } from './lightboxContext.ts';

// This module must export components only (no hooks, no context objects)
// so Vite can Fast Refresh it in isolation — see the note on
// LightboxContext in lightboxContext.ts. `useLightbox` lives there.

export function LightboxProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeGuardRef = useRef<(() => boolean) | null>(null);
  const [content, setContent] = useState<ReactNode>(null);
  const [variant, setVariant] = useState<'rich' | 'text'>('rich');

  const setCloseGuard = useCallback<LightboxState['setCloseGuard']>((g) => {
    closeGuardRef.current = g;
  }, []);

  const tryClose = useCallback(() => {
    const guard = closeGuardRef.current;
    if (guard && !guard()) return;
    dialogRef.current?.close();
  }, []);

  const open = useCallback<LightboxState['open']>((c, opts) => {
    // Clear any guard left behind by a previously-mounted modal.
    closeGuardRef.current = null;
    setContent(c);
    setVariant(opts?.variant ?? 'rich');
    const d = dialogRef.current;
    if (!d) return;
    // Apply the source panel's .hued theme to the dialog, if any. Clearing
    // is important too — a previous themed open shouldn't carry over to
    // an unthemed one.
    if (opts?.theme) {
      d.style.setProperty('--panel-theme-bg', opts.theme.background);
      d.style.setProperty('--panel-theme-fg', opts.theme.foreground);
      d.classList.add('has-theme');
    } else {
      d.style.removeProperty('--panel-theme-bg');
      d.style.removeProperty('--panel-theme-fg');
      d.classList.remove('has-theme');
    }
    // showModal() throws InvalidStateError if the dialog is already open —
    // which silently breaks "click a different message while lightbox is up."
    // Updating the content is enough in that case.
    if (!d.open) d.showModal();
  }, []);
  const close = useCallback(() => dialogRef.current?.close(), []);

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
    // preventDefault() on it suppresses the close so a guard can block.
    const cancel = (e: Event) => {
      const guard = closeGuardRef.current;
      if (guard && !guard()) e.preventDefault();
    };
    d.addEventListener('cancel', cancel);
    return () => {
      d.removeEventListener('click', handler);
      d.removeEventListener('cancel', cancel);
    };
  }, [tryClose]);

  return (
    <LightboxContext.Provider value={{ open, close, setCloseGuard }}>
      {children}
      <dialog ref={dialogRef} className={`lightbox lightbox-${variant}`}>
        <button type="button" className="lightbox-close" onClick={tryClose} aria-label="Close">
          ×
        </button>
        <div className="lightbox-inner">{content}</div>
      </dialog>
    </LightboxContext.Provider>
  );
}
