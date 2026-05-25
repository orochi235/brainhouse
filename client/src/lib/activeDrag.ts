/** Module-level snapshot of the currently-active panel drag. Set on
 * dragstart, cleared on dragend. Used by dragover handlers that can read
 * the dataTransfer's `types` list but NOT its values (the HTML5 drag
 * spec hides values until drop to thwart cross-origin sniffing).
 * Knowing the source panel's identity during dragover lets us validate
 * drop targets (e.g., only the source's parent is a valid re-dock
 * target). */
export interface ActiveDrag {
  id: string;
  from: 'grid' | 'nested';
  parentId: string | null;
  isBrokenOut: boolean;
}

let activeDrag: ActiveDrag | null = null;

export function getActiveDrag(): ActiveDrag | null {
  return activeDrag;
}

export function setActiveDrag(d: ActiveDrag | null): void {
  activeDrag = d;
}
