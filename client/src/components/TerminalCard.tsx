import type { TerminalItem } from '../lib/pipeline.ts';
import { CapsuleRow } from './CapsuleRow.tsx';

interface Props {
  item: TerminalItem;
  startedAt?: number;
}

export function TerminalCard({ item, startedAt }: Props) {
  return (
    <CapsuleRow kind="terminal" ts={item.ts} startedAt={startedAt}>
      <div className="terminal-card">
        {item.entries.map((entry, i) => (
          <div className="terminal-entry" data-source={entry.source} key={`${entry.event.uuid}-${i}`}>
            {entry.input !== null && (
              <div className="terminal-cmd">
                <span className="terminal-prompt" aria-hidden="true">
                  $
                </span>
                <span className="terminal-cmd-text">{entry.input}</span>
              </div>
            )}
            {entry.stdout && <pre className="terminal-stdout">{entry.stdout}</pre>}
            {entry.stderr && <pre className="terminal-stderr">{entry.stderr}</pre>}
            {Object.entries(entry.extras).map(([name, body]) => (
              <pre className="terminal-extra" data-name={name} key={name}>
                {body}
              </pre>
            ))}
          </div>
        ))}
      </div>
    </CapsuleRow>
  );
}
