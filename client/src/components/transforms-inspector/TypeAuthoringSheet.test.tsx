import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Event } from '@server/parser.ts';
import { SelectorStoreProvider } from '../../transforms/selectors/store.tsx';
import { TypeAuthoringSheet } from './TypeAuthoringSheet.tsx';

const FAKE_EVENT: Event = {
  uuid: 'abc123def456',
  parent_uuid: null,
  session_id: 's',
  ts: 0,
  kind: 'tool_use',
  payload: { tool_use_id: 't', name: 'Bash', input: {} },
} as unknown as Event;

function frame(props: Partial<React.ComponentProps<typeof TypeAuthoringSheet>> = {}) {
  return render(
    <SelectorStoreProvider>
      <TypeAuthoringSheet
        recentEvents={[]}
        onCancel={vi.fn()}
        onSave={vi.fn()}
        {...props}
      />
    </SelectorStoreProvider>,
  );
}

describe('<TypeAuthoringSheet>', () => {
  it('shows the empty-events hint when pick is active and no events are passed', () => {
    frame();
    expect(screen.getByText(/no events in the current panel/i)).toBeInTheDocument();
  });

  it('picking an event populates the workbench with an inferred selector', () => {
    frame({ recentEvents: [FAKE_EVENT] });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'abc123def456' } });
    // Selector source field shows the inferred string as its placeholder.
    const fields = screen.getAllByRole('textbox');
    expect(fields[0]).toHaveAttribute(
      'placeholder',
      'event[kind=tool_use] > tool_use[name=Bash]',
    );
    expect(screen.getByText(/Matches sample\?/)).toBeInTheDocument();
  });

  it('Save errors out when name is missing', () => {
    const onSave = vi.fn();
    frame({ onSave });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/name is required/i)).toBeInTheDocument();
  });

  it('Save calls onSave with a `user.` key derived from name', () => {
    const onSave = vi.fn();
    frame({ recentEvents: [FAKE_EVENT], onSave });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'abc123def456' } });
    // Field order: selector source, name, key, description.
    const fields = screen.getAllByRole('textbox');
    // Type a selector source first.
    fireEvent.change(fields[0]!, { target: { value: 'event[kind=tool_use]' } });
    fireEvent.change(fields[1]!, { target: { value: 'My Selector' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      key: 'user.my-selector',
      name: 'My Selector',
      selector: 'event[kind=tool_use]',
    });
  });
});
