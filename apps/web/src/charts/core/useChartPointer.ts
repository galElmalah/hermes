/**
 * Pointer + keyboard + touch handling for snapped crosshairs. Writes into a HoverSync (never
 * React state per frame); keyboard moves are also announced through a polite live region.
 *
 * Touch: the interactive element carries `touch-action: pan-y`, so the browser owns vertical
 * drags (page scroll) and hands horizontal drags to us. A touch only starts scrubbing once it
 * moves mostly sideways; a touch that turns into a vertical scroll gets `pointercancel`, which
 * clears the crosshair (no stuck tooltip). A tap (no movement) inspects that point and the
 * value stays after lifting (there is no hover on touch); the next touch replaces or clears it.
 *
 * `anchor` exposes the driving pointer's client position (null when another synced chart or
 * the keyboard drives), so tooltips can sit next to the finger / cursor instead of a fixed spot.
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createHoverSync, type HoverSync } from './hover';

export interface PointerAnchorPoint {
  clientX: number;
  clientY: number;
  touch: boolean;
}
/** Read-only store of the pointer that drives this chart's crosshair. */
export interface PointerAnchor {
  get(): PointerAnchorPoint | null;
  subscribe(fn: () => void): () => void;
}

interface Options<K> {
  keys: readonly K[];
  /** Map a pointer position (relative to the interactive element) to the nearest key. */
  keyAt: (x: number, y: number) => K | null;
  sync: HoverSync<K>;
  /** Unique id of this chart (so synced charts can tell who is driving). */
  id: string;
  onActivate?: (k: K) => void;
  /** Text announced for keyboard focus moves. */
  describe?: (k: K) => string;
  /** Key focused first when keyboard navigation starts. */
  initialKey?: K | null;
  /** Shift+Arrow step size. */
  bigStep?: number;
}

/** Sideways movement (px) before a touch counts as a scrub. */
const TOUCH_SLOP = 4;

export function useChartPointer<K>({ keys, keyAt, sync, id, onActivate, describe, initialKey, bigStep = 7 }: Options<K>) {
  const [live, setLive] = useState('');
  const downAt = useRef<{ x: number; y: number } | null>(null);
  /** Touch gesture state: pending (not yet sideways) → scrub; null when no touch is down. */
  const touch = useRef<'pending' | 'scrub' | null>(null);
  const [store] = useState(() => createHoverSync<PointerAnchorPoint>());
  const anchor = useMemo<PointerAnchor>(() => ({ get: () => (sync.source() === id ? store.get() : null), subscribe: store.subscribe }), [store, sync, id]);

  const rel = (e: PointerEvent<Element>) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const point = useCallback(
    (e: PointerEvent<Element>) => {
      const p = rel(e);
      const touchPtr = e.pointerType === 'touch';
      const k = keyAt(p.x, p.y);
      // a finger scrubbing past the plot edge keeps the last (edge) value instead of dropping it
      if (k == null && touchPtr && touch.current === 'scrub' && sync.source() === id && sync.get() != null) return;
      // anchor first so the tooltip re-renders with the new position in the same pass
      store.set({ clientX: e.clientX, clientY: e.clientY, touch: touchPtr }, id);
      sync.set(k, id);
    },
    [keyAt, sync, id, store],
  );
  const clear = useCallback(() => {
    if (sync.source() === id) sync.set(null, id);
    store.set(null, id);
  }, [sync, id, store]);

  const onPointerMove = useCallback(
    (e: PointerEvent<Element>) => {
      if (e.pointerType === 'touch') {
        if (!touch.current) return;
        if (touch.current === 'pending') {
          const p = rel(e);
          const d = downAt.current ?? p;
          const dx = Math.abs(p.x - d.x);
          const dy = Math.abs(p.y - d.y);
          // Mostly vertical: leave it to the browser (it scrolls and sends pointercancel).
          if (dx < TOUCH_SLOP || dx < dy) return;
          touch.current = 'scrub';
        }
      }
      point(e);
    },
    [point],
  );
  const onPointerDown = useCallback(
    (e: PointerEvent<Element>) => {
      downAt.current = rel(e);
      if (e.pointerType === 'touch') touch.current = 'pending';
    },
    [],
  );
  const onPointerUp = useCallback(
    (e: PointerEvent<Element>) => {
      const p = rel(e);
      const d = downAt.current;
      downAt.current = null;
      if (e.pointerType === 'touch') {
        // tap: inspect this point (kept after lifting; there is no hover on touch)
        if (touch.current === 'pending') point(e);
        touch.current = null;
        return;
      }
      if (d && Math.hypot(p.x - d.x, p.y - d.y) < 6 && onActivate) {
        const k = keyAt(p.x, p.y);
        if (k != null) onActivate(k);
      }
    },
    [keyAt, onActivate, point],
  );
  const onPointerCancel = useCallback(() => {
    // the browser took the gesture (vertical page scroll): drop the crosshair cleanly
    downAt.current = null;
    touch.current = null;
    clear();
  }, [clear]);
  const onPointerLeave = useCallback(
    (e: PointerEvent<Element>) => {
      if (e.pointerType === 'touch') return; // keep the tap / scrub-inspected value
      clear();
    },
    [clear],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<Element>) => {
      if (!keys.length) return;
      const cur = sync.get();
      let i = cur == null ? -1 : keys.indexOf(cur);
      const step = e.shiftKey ? bigStep : 1;
      let handled = true;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          i = i < 0 ? (initialKey != null ? keys.indexOf(initialKey) : keys.length - 1) : Math.min(keys.length - 1, i + step);
          break;
        case 'ArrowLeft':
        case 'ArrowDown':
          i = i < 0 ? (initialKey != null ? keys.indexOf(initialKey) : keys.length - 1) : Math.max(0, i - step);
          break;
        case 'Home':
          i = 0;
          break;
        case 'End':
          i = keys.length - 1;
          break;
        case 'Escape':
          sync.set(null, id);
          return;
        case 'Enter':
        case ' ':
          if (cur != null && onActivate) onActivate(cur);
          else handled = false;
          break;
        default:
          handled = false;
      }
      if (!handled) return;
      e.preventDefault();
      if (e.key === 'Enter' || e.key === ' ') return;
      const k = keys[Math.max(0, i)];
      store.set(null, id); // keyboard drives: tooltips fall back to their default spot
      sync.set(k, id);
      if (describe) setLive(describe(k));
    },
    [keys, sync, id, onActivate, describe, initialKey, bigStep, store],
  );

  const onBlur = useCallback(() => {
    if (sync.source() === id) sync.set(null, id);
  }, [sync, id]);

  return {
    handlers: { onPointerMove, onPointerDown, onPointerUp, onPointerCancel, onPointerLeave, onKeyDown, onBlur },
    live,
    anchor,
  };
}
