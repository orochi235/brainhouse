import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { LightboxProvider } from './lightbox.tsx';
import { useLightbox } from './lightboxContext.ts';

function wrap({ children }: { children: ReactNode }) {
  return <LightboxProvider>{children}</LightboxProvider>;
}

describe('LightboxProvider / useLightbox', () => {
  it('useLightbox throws outside a provider', () => {
    expect(() => renderHook(() => useLightbox())).toThrow(/inside LightboxProvider/);
  });

  it('open() renders the supplied content', () => {
    const { result } = renderHook(() => useLightbox(), { wrapper: wrap });
    act(() => result.current.open(<p>hello lightbox</p>));
    expect(screen.getByText('hello lightbox')).toBeInTheDocument();
  });

  it('close() removes the open attribute from the dialog', () => {
    const { result, container } = renderInProviderWithDialogRef();
    act(() => result.open(<p>x</p>));
    const dialog = container.querySelector('dialog');
    if (!dialog) throw new Error('dialog missing');
    // happy-dom doesn't fully simulate showModal(); we assert state we control.
    act(() => result.close());
    expect(dialog.open).toBe(false);
  });

  it('applies the hued theme via CSS vars + .has-theme class', () => {
    const { result, container } = renderInProviderWithDialogRef();
    act(() =>
      result.open(<p>themed</p>, {
        theme: { background: '#320053', foreground: '#fff' },
      }),
    );
    const dialog = container.querySelector('dialog');
    if (!dialog) throw new Error('dialog missing');
    expect(dialog.classList.contains('has-theme')).toBe(true);
    expect(dialog.style.getPropertyValue('--panel-theme-bg')).toBe('#320053');
    expect(dialog.style.getPropertyValue('--panel-theme-fg')).toBe('#fff');
  });

  it('clears the theme when a subsequent open() omits one', () => {
    const { result, container } = renderInProviderWithDialogRef();
    act(() =>
      result.open(<p>themed</p>, {
        theme: { background: '#320053', foreground: '#fff' },
      }),
    );
    act(() => result.open(<p>plain</p>));
    const dialog = container.querySelector('dialog');
    if (!dialog) throw new Error('dialog missing');
    expect(dialog.classList.contains('has-theme')).toBe(false);
    expect(dialog.style.getPropertyValue('--panel-theme-bg')).toBe('');
  });

  it('open() with variant: "text" switches the dialog class', () => {
    const { result, container } = renderInProviderWithDialogRef();
    act(() => result.open(<p>x</p>, { variant: 'text' }));
    expect(container.querySelector('dialog')?.className).toContain('lightbox-text');
  });

  it('open() while open pushes: back button appears and pops to the prior view', () => {
    const { result, container } = renderInProviderWithDialogRef();
    act(() => result.open(<p>outer view</p>));
    expect(container.querySelector('.lightbox-back')).toBeNull();
    act(() => result.open(<p>inner view</p>));
    expect(screen.getByText('inner view')).toBeInTheDocument();
    expect(screen.queryByText('outer view')).toBeNull();
    const backBtn = container.querySelector<HTMLButtonElement>('.lightbox-back');
    if (!backBtn) throw new Error('back button missing');
    act(() => backBtn.click());
    expect(screen.getByText('outer view')).toBeInTheDocument();
    expect(container.querySelector('.lightbox-back')).toBeNull();
    // Dialog stayed open throughout — back never closes from a stacked view.
    expect(container.querySelector('dialog')?.open).toBe(true);
  });

  it('popping restores the prior entry theme and variant', () => {
    const { result, container } = renderInProviderWithDialogRef();
    act(() =>
      result.open(<p>themed root</p>, {
        theme: { background: '#320053', foreground: '#fff' },
      }),
    );
    act(() => result.open(<p>plain detail</p>, { variant: 'text' }));
    const dialog = container.querySelector('dialog');
    if (!dialog) throw new Error('dialog missing');
    expect(dialog.classList.contains('has-theme')).toBe(false);
    expect(dialog.className).toContain('lightbox-text');
    const backBtn = container.querySelector<HTMLButtonElement>('.lightbox-back');
    if (!backBtn) throw new Error('back button missing');
    act(() => backBtn.click());
    expect(dialog.classList.contains('has-theme')).toBe(true);
    expect(dialog.style.getPropertyValue('--panel-theme-bg')).toBe('#320053');
    expect(dialog.className).toContain('lightbox-rich');
  });

  it('closing drops the stack — reopening starts fresh with no back button', () => {
    const { result, container } = renderInProviderWithDialogRef();
    act(() => result.open(<p>outer</p>));
    act(() => result.open(<p>inner</p>));
    act(() => result.close());
    act(() => result.open(<p>fresh</p>));
    expect(screen.getByText('fresh')).toBeInTheDocument();
    expect(container.querySelector('.lightbox-back')).toBeNull();
  });

  it('Esc (cancel event) pops instead of closing while stacked', () => {
    const { result, container } = renderInProviderWithDialogRef();
    act(() => result.open(<p>outer</p>));
    act(() => result.open(<p>inner</p>));
    const dialog = container.querySelector('dialog');
    if (!dialog) throw new Error('dialog missing');
    const cancelEvent = new Event('cancel', { cancelable: true });
    act(() => {
      dialog.dispatchEvent(cancelEvent);
    });
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(screen.getByText('outer')).toBeInTheDocument();
    // At the root, cancel is allowed through (native close proceeds).
    const rootCancel = new Event('cancel', { cancelable: true });
    act(() => {
      dialog.dispatchEvent(rootCancel);
    });
    expect(rootCancel.defaultPrevented).toBe(false);
  });
});

// Render the provider and return both the hook result and the rendered
// container so individual tests can inspect the dialog DOM.
function renderInProviderWithDialogRef() {
  const ref: { current: ReturnType<typeof useLightbox> | null } = { current: null };
  function Bridge() {
    ref.current = useLightbox();
    return null;
  }
  const utils = render(
    <LightboxProvider>
      <Bridge />
    </LightboxProvider>,
  );
  if (!ref.current) throw new Error('hook did not initialize');
  return { result: ref.current, container: utils.container };
}
