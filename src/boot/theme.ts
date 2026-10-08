// The render-blocking boot script (requirements R4, R4a, R24 and R26). The
// build turns this file into a small classic script and places it in <head>
// before the stylesheet, so the theme and style attributes are on <html>
// before the first paint: a dark-mode user never sees a flash of the light
// theme, and a style never flashes into another. No inline script is
// involved, so the Content Security Policy stays as it is.
//
// The build replaces `__PASSGEN_BOOT__` with the configured defaults (C1)
// and the storage constants of src/boot/storage.ts, and inlines the pure
// validator of src/boot/stored-settings.ts in place of the include marker
// below. When the user has saved their settings (R24), the stored theme and
// style replace the defaults, but only when the whole record passes the same
// checks the app applies (R26): so the app never has to undo what this script
// did, and the first paint is the final paint.
//
// This file cannot import anything and must never throw: storage can be
// disabled, full or missing, and the page must still render.

// __PASSGEN_TYPES_BEGIN__
// The inlined validator's function and types, declared for the type checker
// only. The compiler drops this block when it inlines the real definitions.
declare const parseStoredText: typeof import("./stored-settings.ts").parseStoredText;
type StoredLimits = import("./stored-settings.ts").StoredLimits;
// __PASSGEN_TYPES_END__

declare const __PASSGEN_BOOT__: {
  /** The default theme: "system", "light" or "dark". */
  readonly theme: string;
  /** The default style's id. */
  readonly style: string;
  /** The localStorage key of the saved settings. */
  readonly key: string;
  /** The longest stored text that is read at all. */
  readonly textLimit: number;
  /** The bounds a stored record must respect, including the offered styles and the schema version. */
  readonly limits: StoredLimits;
};

// __PASSGEN_INCLUDE__ src/boot/stored-settings.ts

(() => {
  const boot = __PASSGEN_BOOT__;
  let theme = boot.theme;
  let style = boot.limits.styles.includes(boot.style) ? boot.style : (boot.limits.styles[0] ?? boot.style);
  try {
    const stored = parseStoredText(localStorage.getItem(boot.key), boot.textLimit, boot.limits);
    if (stored) {
      theme = stored.theme;
      style = stored.style;
    }
  } catch {
    // Storage is disabled or missing: the defaults stand.
  }
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.style = style;
})();
