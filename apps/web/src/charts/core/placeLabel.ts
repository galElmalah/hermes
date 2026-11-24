/**
 * Placement for in-plot value labels and tooltips that follow a crosshair.
 *
 * The label sits beside the vertical rule (never on it), on the preferred side, and flips to the
 * other side when it would leave the bounds. When neither side has room (a wide tooltip on a
 * phone) it centres on the rule and moves above the focus point instead (below if there is no
 * room above). Vertically it is clamped inside the bounds.
 */
export interface LabelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PlaceOptions {
  /** Crosshair x. */
  x: number;
  /** Vertical focus: the pointer / finger or the datum (or the preferred top for `align: 'top'`). */
  y: number;
  w: number;
  h: number;
  bounds: LabelBounds;
  /** Horizontal gap between the rule and the label. */
  gap?: number;
  prefer?: 'left' | 'right';
  /** center = label centred on y · above = label just above y (touch: keeps clear of the finger) · top = y is the label's top. */
  align?: 'center' | 'above' | 'top';
}

export function placeLabel({ x, y, w, h, bounds, gap = 10, prefer = 'right', align = 'center' }: PlaceOptions) {
  const rx = x + gap;
  const lx = x - gap - w;
  const fitsR = rx + w <= bounds.right;
  const fitsL = lx >= bounds.left;
  const side: 'left' | 'right' | 'over' = prefer === 'right' ? (fitsR ? 'right' : fitsL ? 'left' : 'over') : fitsL ? 'left' : fitsR ? 'right' : 'over';
  let tx: number;
  let ty = align === 'top' ? y : align === 'above' ? y - h - 8 : y - h / 2;
  if (side === 'over') {
    tx = x - w / 2;
    if (align !== 'top') {
      ty = y - h - gap;
      if (ty < bounds.top) ty = y + gap;
    }
  } else tx = side === 'right' ? rx : lx;
  tx = Math.max(bounds.left, Math.min(bounds.right - w, tx));
  ty = Math.max(bounds.top, Math.min(bounds.bottom - h, ty));
  return { x: tx, y: ty, side };
}
