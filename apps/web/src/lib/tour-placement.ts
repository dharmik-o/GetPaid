// Where the tour's popover goes: beside the highlighted element, flipped to the side that has room.

export type Box = { top: number; left: number; width: number; height: number };
export type Size = { width: number; height: number };

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, Math.max(min, max)));

/** Below, above, right, then left of the target; the first that fits. Always kept on screen. */
export const placeCard = (target: Box, card: Size, view: Size, gap = 14, margin = 16) => {
  const centredLeft = clamp(
    target.left + target.width / 2 - card.width / 2,
    margin,
    view.width - card.width - margin,
  );
  const centredTop = clamp(
    target.top + target.height / 2 - card.height / 2,
    margin,
    view.height - card.height - margin,
  );
  const below = target.top + target.height + gap;
  const above = target.top - gap - card.height;
  const right = target.left + target.width + gap;
  const left = target.left - gap - card.width;
  const fitsY = (top: number) => top >= margin && top + card.height <= view.height - margin;
  const fitsX = (x: number) => x >= margin && x + card.width <= view.width - margin;
  if (fitsY(below)) return { top: below, left: centredLeft };
  if (fitsY(above)) return { top: above, left: centredLeft };
  if (fitsX(right)) return { top: centredTop, left: right };
  if (fitsX(left)) return { top: centredTop, left };
  // A target as big as the screen: the card sits inside it, near the bottom.
  return { top: clamp(view.height - card.height - margin, margin, view.height), left: centredLeft };
};
