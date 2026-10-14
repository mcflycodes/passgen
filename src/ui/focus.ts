// Keyboard focus is never hidden under the pinned header or below the
// viewport (WCAG 2.4.11). Engines differ in how they scroll a newly focused
// control into view: WebKit leaves a control that is partly on screen where
// it is, even when the pinned header covers it, and engines differ in
// whether that scroll honours scroll-padding. So every keyboard focus is
// checked at once, in the focusin event, and again a frame later, after
// any native focus scroll has run; a ring that is not wholly in the visible
// area is scrolled into it, instantly.
export interface FocusBounds {
  readonly top: number;
  readonly bottom: number;
}

/** Pointer focus and rings already within the visible viewport need no scroll. */
export function needsFocusScroll(keyboard: boolean, ring: FocusBounds, visible: FocusBounds): boolean {
  return keyboard && (ring.top < visible.top || ring.bottom > visible.bottom);
}

/**
 * How far to scroll the page so the ring is wholly in the visible area:
 * negative scrolls up, positive down, zero when it already is. A ring taller
 * than the visible area keeps its top in view.
 */
export function focusScrollDelta(ring: FocusBounds, visible: FocusBounds): number {
  if (ring.top < visible.top) return ring.top - visible.top;
  if (ring.bottom > visible.bottom) return Math.min(ring.bottom - visible.bottom, ring.top - visible.top);
  return 0;
}

/** The element whose focus ring the user sees: the drawn label or box of a hidden radio or checkbox. */
function ringElement(element: HTMLElement): HTMLElement | null {
  const input = element instanceof HTMLInputElement ? element : null;
  const proxy =
    input?.type === "radio"
      ? [...document.querySelectorAll<HTMLLabelElement>("label")].find((label) => label.htmlFor === input.id)
      : input?.type === "checkbox"
        ? element.nextElementSibling
        : element;
  return proxy instanceof HTMLElement ? proxy : null;
}

/** The ring's bounds and the area it must lie in, below the pinned header and within the viewport. */
function measure(element: HTMLElement, proxy: HTMLElement): { ring: FocusBounds; visible: FocusBounds } {
  const style = getComputedStyle(proxy);
  const extent = Math.max(0, Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth));
  const rect = proxy.getBoundingClientRect();
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const bottom = top + (viewport?.height ?? window.innerHeight);
  const header = document.querySelector<HTMLElement>(".top");
  const covered =
    header && !header.contains(element) && getComputedStyle(header).position === "sticky"
      ? header.getBoundingClientRect().bottom
      : top;
  return {
    ring: { top: rect.top - extent, bottom: rect.bottom + extent },
    visible: { top: Math.max(top, covered), bottom },
  };
}

/** Scrolls a hidden or clipped keyboard focus ring into the visible area, without changing focus. */
function reveal(element: HTMLElement): void {
  if (document.activeElement !== element || !element.matches(":focus-visible")) return;
  const proxy = ringElement(element);
  if (!proxy) return;
  const first = measure(element, proxy);
  if (!needsFocusScroll(true, first.ring, first.visible)) return;
  // Explicitly instant even if a user stylesheet enables smooth scrolling.
  proxy.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  // An engine that ignores scroll-padding here leaves the ring under the
  // pinned header; move the page the rest of the way.
  const after = measure(element, proxy);
  const delta = focusScrollDelta(after.ring, after.visible);
  if (delta !== 0) window.scrollTo({ top: window.scrollY + delta, behavior: "instant" });
}

export function mountFocusVisibility(): void {
  let frame = 0;
  document.addEventListener("focusin", (event) => {
    cancelAnimationFrame(frame);
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;
    reveal(element);
    // Again after the engine's own focus scroll, which runs after focusin.
    frame = requestAnimationFrame(() => reveal(element));
  });
}
