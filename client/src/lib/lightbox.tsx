import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

interface LightboxTheme {
  background: string;
  foreground: string;
}

interface LightboxState {
  open: (
    content: ReactNode,
    opts?: { variant?: 'rich' | 'text'; theme?: LightboxTheme | null },
  ) => void;
  close: () => void;
}

const Ctx = createContext<LightboxState | null>(null);

export function LightboxProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [content, setContent] = useState<ReactNode>(null);
  const [variant, setVariant] = useState<'rich' | 'text'>('rich');

  const open = useCallback<LightboxState['open']>((c, opts) => {
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
      const box = d.querySelector<HTMLElement>('.lightbox-inner');
      if (!box) return;
      const r = box.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        d.close();
      }
    };
    d.addEventListener('click', handler);
    return () => d.removeEventListener('click', handler);
  }, []);

  return (
    <Ctx.Provider value={{ open, close }}>
      {children}
      <dialog ref={dialogRef} className={`lightbox lightbox-${variant}`}>
        <button type="button" className="lightbox-close" onClick={close} aria-label="Close">
          ×
        </button>
        <div className="lightbox-inner">{content}</div>
      </dialog>
    </Ctx.Provider>
  );
}

export function useLightbox(): LightboxState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useLightbox must be inside LightboxProvider');
  return ctx;
}
