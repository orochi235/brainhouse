import restoreIcon from '../assets/icons/restore-arc.svg?raw';
import pinIcon from '../assets/icons/pin.svg?raw';
import trashIcon from '../assets/icons/trash.svg?raw';
import { SvgGlyph } from './SvgGlyph.tsx';

interface Props {
  onRestore: () => void;
  onPinToMinibar: () => void;
  onTrash: () => void;
}

export function MiniHoverToolbar({ onRestore, onPinToMinibar, onTrash }: Props) {
  return (
    <div className="mini-hover-toolbar" aria-hidden={false}>
      <ToolbarButton
        kind="restore"
        title="Restore to grid"
        svg={restoreIcon}
        onClick={onRestore}
      />
      <ToolbarButton
        kind="pin"
        title="Pin to minibar"
        svg={pinIcon}
        onClick={onPinToMinibar}
      />
      <ToolbarButton
        kind="trash"
        title="Remove"
        svg={trashIcon}
        onClick={onTrash}
      />
    </div>
  );
}

function ToolbarButton({
  kind,
  title,
  svg,
  onClick,
}: {
  kind: 'restore' | 'pin' | 'trash';
  title: string;
  svg: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`mini-hover-toolbar__btn mini-hover-toolbar__btn--${kind}`}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <SvgGlyph svg={svg} className="svg-glyph" />
    </button>
  );
}
