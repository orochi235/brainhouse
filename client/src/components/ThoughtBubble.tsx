import classNames from 'classnames';
import { Markdown } from './Markdown.tsx';

interface Props {
  text: string;
  speaker: 'agent' | 'user';
  /** Click handler — typically opens the full turn / raw text in a lightbox. */
  onClick?: () => void;
}

/**
 * Thought-bubble presentation — a comic-style balloon attributed to the
 * agent. Used for `thinking` events (the model's internal monologue).
 * The `user` speaker variant is wired but unused; users don't have
 * "thoughts" in the UI sense — their typed messages render as speech.
 *
 * Picks up panel theming via the same `.has-theme` selector machinery the
 * regular bubbles use; iMessage view mode mirrors the user/agent column.
 *
 * Tail: a trailing chain of bubbles diminishing in size, leading away
 * from the speaker's edge into the rest of the conversation.
 */
export function ThoughtBubble({ text, speaker, onClick }: Props) {
  return (
    <li
      className={classNames('event', 'event-thought', `event-thought-${speaker}`)}
      onClick={onClick}
    >
      <div className={classNames('thought-bubble', `thought-bubble-${speaker}`)}>
        <span className="thought-bubble-tail" aria-hidden="true">
          <span className="thought-bubble-tail-dot thought-bubble-tail-dot-1" />
          <span className="thought-bubble-tail-dot thought-bubble-tail-dot-2" />
          <span className="thought-bubble-tail-dot thought-bubble-tail-dot-3" />
        </span>
        <div className="thought-bubble-body">
          <Markdown text={text} escape={speaker === 'user'} />
        </div>
      </div>
    </li>
  );
}
