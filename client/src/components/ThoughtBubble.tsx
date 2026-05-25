// TODO(tags): once the tag system lands, route bubbles into this component
// by checking `event.tags.has('thinking')` (agent thought) and
// `event.tags.has('meta')` (user meta thought) instead of the current
// `event.kind === 'thinking'` / `payload.is_meta` checks living in
// EventList.tsx.

import classNames from 'classnames';
import { Markdown } from './Markdown.tsx';

interface Props {
  text: string;
  speaker: 'agent' | 'user';
  /** Click handler — typically opens the full turn / raw text in a lightbox. */
  onClick?: () => void;
}

/**
 * Thought-bubble presentation — a dashed-edged comic-style balloon attributed
 * to one of the conversants. Used for `thinking` events (agent thought) and
 * for `is_meta: true` synthetic user_texts (e.g. Skill SKILL.md preludes that
 * Claude Code injects on the user's behalf).
 *
 * Picks up panel theming via the same `.has-theme` selector machinery the
 * regular bubbles use; iMessage view mode mirrors the user/agent column.
 */
export function ThoughtBubble({ text, speaker, onClick }: Props) {
  return (
    <li
      className={classNames('event', 'event-thought', `event-thought-${speaker}`)}
      onClick={onClick}
    >
      <div className={classNames('thought-bubble', `thought-bubble-${speaker}`)}>
        <span className="thought-bubble-tail" aria-hidden="true">
          <span className="thought-bubble-tail-dot thought-bubble-tail-dot-big" />
          <span className="thought-bubble-tail-dot thought-bubble-tail-dot-small" />
        </span>
        <div className="thought-bubble-body">
          <Markdown text={text} escape={speaker === 'user'} />
        </div>
      </div>
    </li>
  );
}
