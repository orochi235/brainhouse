import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LightboxProvider } from '../lib/lightbox.tsx';
import type { ViewItem } from '../lib/pipeline.ts';
import { ToolCapsule } from './ToolCapsule.tsx';

type ToolItem = Extract<ViewItem, { type: 'tool' }>;

function toolItem(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    type: 'tool',
    anchorUuid: 'u1',
    use: { tool_use_id: 't1', name: 'Bash', input: { command: 'echo hi' } },
    result: { tool_use_id: 't1', content: 'hi\n', is_error: false },
    ack: null,
    ts: '2026-05-19T00:00:00Z',
    ...overrides,
  };
}

function renderInLightbox(node: React.ReactNode) {
  return render(<LightboxProvider>{node}</LightboxProvider>);
}

describe('<ToolCapsule>', () => {
  it('shows the summarized label', () => {
    renderInLightbox(<ToolCapsule item={toolItem()} />);
    expect(screen.getByText(/echo hi/)).toBeInTheDocument();
  });

  it('marks ok status with a checkmark', () => {
    renderInLightbox(<ToolCapsule item={toolItem()} />);
    expect(screen.getByLabelText('ok')).toHaveTextContent('✓');
  });

  it('marks error status with an x', () => {
    renderInLightbox(
      <ToolCapsule
        item={toolItem({
          result: { tool_use_id: 't1', content: 'boom', is_error: true },
        })}
      />,
    );
    expect(screen.getByLabelText('error')).toHaveTextContent('✗');
  });

  it('adds the canceled class when item.canceled is set', () => {
    const { container } = renderInLightbox(<ToolCapsule item={toolItem({ canceled: true })} />);
    expect(container.querySelector('.tool-capsule')).toHaveClass('canceled');
    expect(container.querySelector('.event-tool')).toHaveClass('canceled');
  });

  it('omits the cancellation class otherwise', () => {
    const { container } = renderInLightbox(<ToolCapsule item={toolItem()} />);
    expect(container.querySelector('.tool-capsule')).not.toHaveClass('canceled');
  });

  it('renders pending status with an empty status cell when no result yet', () => {
    renderInLightbox(<ToolCapsule item={toolItem({ result: null })} />);
    const status = screen.getByLabelText('pending');
    expect(status).toHaveTextContent('');
  });
});
