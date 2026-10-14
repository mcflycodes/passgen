// The Appearance button of the narrow header. Below 900px the Style and
// theme controls fold into a panel under the pinned one-row header, so the
// header never wraps; the button opens and closes it (a disclosure: its
// aria-expanded is the panel's one state, and the stylesheet shows the panel
// from it). Escape closes the panel and puts focus back on the button, as
// does a click outside it; moving focus out of the panel closes it, and so
// does widening the window past 900px, where the button is hidden and the
// controls sit in the header row.

import { byId } from "./dom.ts";

/** The width from which the Style and theme controls sit in the header row (src/styles.css). */
export const APPEARANCE_INLINE_QUERY = "(min-width: 900px)";

export function mountAppearanceMenu(): void {
  const toggle = byId("appearance-toggle", HTMLButtonElement);
  const panel = byId("appearance-panel", HTMLElement);
  const isOpen = () => toggle.getAttribute("aria-expanded") === "true";
  const setOpen = (open: boolean) => toggle.setAttribute("aria-expanded", String(open));
  const inMenu = (node: unknown) => node instanceof Node && (panel.contains(node) || toggle.contains(node));
  const close = (restoreFocus: boolean) => {
    if (!isOpen()) return;
    setOpen(false);
    if (restoreFocus) toggle.focus();
  };

  toggle.addEventListener("click", () => setOpen(!isOpen()));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen()) return;
    event.preventDefault();
    close(true);
  });
  // A press outside closes the panel. Focus that was in the panel returns to
  // the button unless the press itself put focus somewhere else.
  let focusWasInMenu = false;
  document.addEventListener(
    "pointerdown",
    (event) => {
      focusWasInMenu = isOpen() && !inMenu(event.target) && inMenu(document.activeElement);
    },
    true,
  );
  document.addEventListener("click", (event) => {
    if (!isOpen() || inMenu(event.target)) return;
    const active = document.activeElement;
    close(focusWasInMenu && (active === null || active === document.body || inMenu(active)));
    focusWasInMenu = false;
  });
  panel.addEventListener("focusout", (event) => {
    if (event.relatedTarget !== null && !inMenu(event.relatedTarget)) close(false);
  });
  toggle.addEventListener("focusout", (event) => {
    if (event.relatedTarget !== null && !inMenu(event.relatedTarget)) close(false);
  });
  matchMedia(APPEARANCE_INLINE_QUERY).addEventListener("change", () => close(false));
}
