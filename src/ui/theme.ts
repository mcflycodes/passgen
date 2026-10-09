// The theme and style controls (R4, R4a). The boot script has already put
// data-theme and data-style on <html> before the first paint, from the same
// defaults or saved settings the store starts with; this module writes the
// store's values to those attributes (so they also hold when the boot script
// accepted a saved theme the app then rejected, R26), syncs the controls to
// them, then applies the user's choices.
//
// System needs no script to follow the operating system: the stylesheet sets
// `color-scheme: light dark` and the styles use light-dark() pairs, so the
// browser switches live with prefers-color-scheme. Light and Dark override it
// by setting color-scheme through data-theme.

import { THEMES, type Theme } from "../boot/storage.ts";
import type { SettingsStore } from "./settings.ts";

function isTheme(value: string | undefined): value is Theme {
  return (THEMES as readonly string[]).includes(value as string);
}

/** The mounted controls; `refresh` shows the store's theme and style after something else changed them (Reset). */
export interface ThemeControls {
  refresh(): void;
}

export function mountThemeControls(store: SettingsStore, onStyleChange: (style: string) => void): ThemeControls {
  const root = document.documentElement;
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="theme"]')];
  // Absent when the configuration offers one style (C1).
  const select = document.getElementById("style");
  const styleSelect = select instanceof HTMLSelectElement ? select : null;
  const offered = styleSelect ? [...styleSelect.options].map((option) => option.value) : [];

  const refresh = () => {
    const { theme, style } = store.current;
    const styleChanged = root.dataset.style !== style;
    root.dataset.theme = theme;
    root.dataset.style = style;
    for (const radio of radios) radio.checked = radio.value === theme;
    if (styleSelect && offered.includes(style)) styleSelect.value = style;
    if (styleChanged) onStyleChange(style);
  };
  root.dataset.theme = store.current.theme;
  root.dataset.style = store.current.style;
  refresh();

  for (const radio of radios) {
    radio.addEventListener("change", () => {
      if (!radio.checked || !isTheme(radio.value)) return;
      root.dataset.theme = radio.value;
      store.update({ theme: radio.value });
    });
  }
  styleSelect?.addEventListener("change", () => {
    const chosen = styleSelect.value;
    if (!offered.includes(chosen)) return;
    root.dataset.style = chosen;
    store.update({ style: chosen });
    onStyleChange(chosen);
  });
  return { refresh };
}
