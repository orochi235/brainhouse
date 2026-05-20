import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { LightboxProvider, useLightbox } from './lightbox.tsx';

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
