import { useCallback, useEffect, useRef } from 'react';
import { useLightbox } from '../../lib/lightboxContext.ts';
import { SearchModal } from './SearchModal.tsx';
import './search.css';

/** True when a keystroke belongs to something the user is typing into. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/**
 * The topbar's search field. Typing in it opens the search modal with the
 * text carried over. ⌘K anywhere, or `/` outside a text field, focuses it.
 * `/?q=<text>` (the menu bar's search) opens the modal on load.
 */
export function SearchField() {
  const lightbox = useLightbox();
  const ref = useRef<HTMLInputElement>(null);

  const openModal = useCallback(
    (q: string) => {
      lightbox.open(<SearchModal initialQuery={q} />);
    },
    [lightbox],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    if (q === null) return;
    params.delete('q');
    const rest = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    openModal(q);
  }, [openModal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target);
      if (!cmdK && !slash) return;
      // Inside an open dialog (the search modal included) leave keys alone.
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <input
      ref={ref}
      type="search"
      className="topbar-search"
      placeholder="Search transcripts  ⌘K"
      aria-label="Search transcripts"
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => {
        const q = e.target.value;
        e.target.value = '';
        e.target.blur();
        openModal(q);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
          openModal('');
        }
      }}
    />
  );
}
