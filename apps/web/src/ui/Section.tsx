/**
 * Section — a titled block inside a page: `title-3` heading (16 semibold, fg-1) + optional fg-2
 * description and right-side actions, 16px above the content. Sections are spaced 48–64px apart by
 * <Page>, so never add dividers or cards just to separate them. `variant="micro"` = a 12px fg-3
 * sentence-case heading for dense asides.
 * Divider — 1px line-1 hairline, horizontal or vertical, optional label. Prefer a gap.
 */
import { ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { PageSection } from '@/motion/PageTransition';
import { spring, tween } from '@/motion/tokens';

/**
 * Collapsible sections: a tappable header (title + chevron) that shows / hides the body with a
 * height + fade animation. The open state is remembered per section in localStorage
 * (`hermes.section.<key>`); until the athlete toggles it, `phone` / `desktop` pick the default by
 * viewport (< 768px is a phone). `openSection(id)` (or the `hermes:open-section` event) opens a
 * section from elsewhere, e.g. the activity page's section nav.
 */
export interface CollapsibleOptions {
  /** Storage key (stable, unique per section kind, e.g. "activity.laps"). */
  key: string;
  /** Default on phones. Default false. */
  phone?: boolean;
  /** Default on wider screens. Default true. */
  desktop?: boolean;
}

const STORE = 'hermes.section.';
const PHONE = '(max-width: 47.99rem)';
const OPEN_EVENT = 'hermes:open-section';

function storedOpen(key: string): boolean | null {
  try {
    const v = localStorage.getItem(STORE + key);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

function defaultOpen(o: CollapsibleOptions): boolean {
  const phone = typeof window !== 'undefined' && window.matchMedia(PHONE).matches;
  return phone ? (o.phone ?? false) : (o.desktop ?? true);
}

/** Open the collapsible section with this DOM id (no-op when it is not collapsible or already open). */
export function openSection(id: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
}

/** Open state of a collapsible section, persisted per key. */
export function useSectionOpen(o: CollapsibleOptions | undefined, id?: string): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => (o ? (storedOpen(o.key) ?? defaultOpen(o)) : true));
  const key = o?.key;
  const set = useCallback(
    (v: boolean) => {
      setOpen(v);
      if (!key) return;
      try {
        localStorage.setItem(STORE + key, v ? '1' : '0');
      } catch {
        /* private mode: state just isn't remembered */
      }
    },
    [key],
  );
  useEffect(() => {
    if (!key || !id) return;
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id) setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, [key, id]);
  return [o ? open : true, set];
}

/** Height + opacity reveal for collapsible bodies (spring.smooth; instant under reduced motion via MotionConfig). */
export function CollapseBody({ open, id, children, className }: { open: boolean; id?: string; children: ReactNode; className?: string }) {
  // overflow is clipped only while animating, so focus rings and popovers inside work when open
  const [settled, setSettled] = useState(open);
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          id={id}
          key="body"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1, transition: { height: spring.smooth, opacity: tween('base') } }}
          exit={{ height: 0, opacity: 0, transition: { height: spring.smooth, opacity: tween('fast', 'in') } }}
          onAnimationStart={() => setSettled(false)}
          onAnimationComplete={() => setSettled(true)}
          style={{ overflow: settled ? 'visible' : 'hidden' }}
          className={className}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The tappable header button: title + chevron (rotates), opaque, full-width hit target. */
export function CollapseToggle({ open, onToggle, controls, children, size = 'title' }: { open: boolean; onToggle: () => void; controls: string; children: ReactNode; size?: 'title' | 'micro' }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        '-mx-2 flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md bg-canvas px-2 text-left transition-colors duration-(--dur-fast) hover:bg-surface-1 focus-visible:outline-2 focus-visible:outline-focus md:min-h-9',
        size === 'title' ? 'text-title-3 text-fg-1' : 'text-label text-fg-3',
      )}
    >
      <span className="min-w-0 flex-1">{children}</span>
      <motion.span aria-hidden className="flex size-6 shrink-0 items-center justify-center text-fg-3" initial={false} animate={{ rotate: open ? 180 : 0 }} transition={spring.snappy}>
        <ChevronDown className="size-4" />
      </motion.span>
    </button>
  );
}

export interface SectionProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** 'title' (title-3, default) or 'micro' (12px fg-3 sentence case, for dense asides). */
  variant?: 'title' | 'micro';
  id?: string;
  className?: string;
  children: ReactNode;
  /** Participate in the page stagger (default true). */
  stagger?: boolean;
  /** Make the section collapsible (needs a `title`). */
  collapsible?: CollapsibleOptions;
  /** Shown next to the title while collapsed (e.g. a count or one key number). */
  collapsedHint?: ReactNode;
  /** Collapsible only: a control beside the toggle, always visible (e.g. a link to the detail page). */
  titleAside?: ReactNode;
}

export function Section({ title, description, actions, variant = 'title', id, className, children, stagger = true, collapsible, collapsedHint, titleAside }: SectionProps) {
  const autoId = useId();
  const [open, setOpen] = useSectionOpen(collapsible, id);
  if (collapsible && title) {
    const bodyId = `${id ?? autoId.replace(/:/g, '')}-body`;
    const head = (
      <header className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2', open ? (variant === 'title' ? 'mb-3 md:mb-4' : 'mb-2') : '')}>
        <div className="min-w-0 flex-1">
          <h2 className={cn('flex items-center gap-2', variant === 'title' ? 'text-title-3 text-fg-1' : 'text-label text-fg-3')}>
            <CollapseToggle open={open} onToggle={() => setOpen(!open)} controls={bodyId} size={variant}>
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{title}</span>
                {!open && collapsedHint && <span className="truncate text-body-sm font-normal text-fg-3">{collapsedHint}</span>}
              </span>
            </CollapseToggle>
            {titleAside}
          </h2>
          {description && open && <p className="mt-1 max-w-[65ch] text-body text-fg-2">{description}</p>}
        </div>
        {actions && open && <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
    );
    const body = (
      <>
        {head}
        <CollapseBody open={open} id={bodyId}>
          {children}
        </CollapseBody>
      </>
    );
    // Closed sections sit close together on phones (a compact list of headers, not a wall of gaps).
    const cls = cn('scroll-mt-20', className, !open && 'max-md:-mt-8');
    return stagger ? (
      <PageSection id={id} className={cls}>
        {body}
      </PageSection>
    ) : (
      <section id={id} className={cls}>
        {body}
      </section>
    );
  }
  const head = (title || actions) && (
    // Wraps on narrow screens: the actions drop under the title instead of pushing it (DESIGN_V2 §9).
    <header className={cn('flex flex-wrap items-end justify-between gap-x-4 gap-y-3', variant === 'title' ? 'mb-4 md:mb-5' : 'mb-3')}>
      <div className="min-w-0">
        {title &&
          (variant === 'title' ? (
            <h2 className="text-title-3 text-fg-1">{title}</h2>
          ) : (
            <h2 className="text-label text-fg-3">{title}</h2>
          ))}
        {description && <p className="mt-1 max-w-[65ch] text-body text-fg-2">{description}</p>}
      </div>
      {actions && <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
  const body = (
    <>
      {head}
      {children}
    </>
  );
  return stagger ? (
    <PageSection id={id} aria-labelledby={undefined} className={cn('scroll-mt-20', className)}>
      {body}
    </PageSection>
  ) : (
    <section id={id} className={cn('scroll-mt-20', className)}>
      {body}
    </section>
  );
}

export function Divider({ orientation = 'horizontal', label, className }: { orientation?: 'horizontal' | 'vertical'; label?: ReactNode; className?: string }) {
  if (orientation === 'vertical') return <span role="separator" aria-orientation="vertical" className={cn('inline-block w-px self-stretch bg-line-1', className)} />;
  if (label)
    return (
      <div role="separator" className={cn('flex items-center gap-3 text-label font-normal text-fg-3', className)}>
        <span className="h-px flex-1 bg-line-1" />
        {label}
        <span className="h-px flex-1 bg-line-1" />
      </div>
    );
  return <hr className={cn('h-px border-0 bg-line-1', className)} />;
}
