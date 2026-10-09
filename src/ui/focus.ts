// Native focus scrolling does not consistently include CSS scroll margins.
// Recheck after it settles and correct only clipped keyboard focus rings.
export interface FocusBounds {
  readonly top: number;
  readonly bottom: number;
}

/** Pointer focus and rings already within the visible viewport need no scroll. */
export function needsFocusScroll(keyboard: boolean, ring: FocusBounds, visible: FocusBounds): boolean {
  return keyboard && (ring.top < visible.top || ring.bottom > visible.bottom);
}

export function mountFocusVisibility(): void {
  let frame = 0;
  document.addEventListener("focusin", (event) => {
    cancelAnimationFrame(frame);
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;
    // Run after the engine's native focus scroll, without changing focus.
    frame = requestAnimationFrame(() => {
      if (document.activeElement !== element || !element.matches(":focus-visible")) return;
      const input = element instanceof HTMLInputElement ? element : null;
      const proxy =
        input?.type === "radio"
          ? [...document.querySelectorAll<HTMLLabelElement>("label")].find((label) => label.htmlFor === input.id)
          : input?.type === "checkbox"
            ? element.nextElementSibling
            : element;
      if (!(proxy instanceof HTMLElement)) return;
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
      if (
        needsFocusScroll(
          true,
          { top: rect.top - extent, bottom: rect.bottom + extent },
          { top: Math.max(top, covered), bottom },
        )
      ) {
        // Explicitly instant even if a user stylesheet enables smooth scrolling.
        element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      }
    });
  });
}
