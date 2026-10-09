// What the boot script and the app share about saved settings (R24 to R26).
// The boot script (src/boot/theme.ts) cannot import anything: the build
// compiles it alone into a classic script, inlining the pure validator in
// src/boot/stored-settings.ts. So the build passes these values to it
// through `__PASSGEN_BOOT__`, and src/ui/settings.ts imports them, so the
// two can never disagree about where the settings are, what shape the
// stored text must have, or which bounds it must respect.

import type { StoredLimits } from "./stored-settings.ts";

/**
 * The one localStorage key. The key carries the schema version, so a build
 * with a new schema never reads an old build's data, and the stored text
 * carries it again, so a copied or edited value cannot pretend to be new.
 */
export const SETTINGS_STORAGE_KEY = "passgen:settings:v2";

/** The `version` the stored text must carry. Raise it with the key when the settings' shape changes. */
export const SETTINGS_SCHEMA_VERSION = 2;

/**
 * The longest stored text that is read at all, in UTF-16 code units. A valid
 * value is a few hundred characters; anything far beyond that is not ours
 * and is refused before it is parsed.
 */
export const SETTINGS_TEXT_LIMIT = 4096;

/** The themes of R4, which both the boot script and the app accept. */
export const THEMES = ["system", "light", "dark"] as const;

export type Theme = (typeof THEMES)[number];

/** The part of the configuration the stored-settings checks need (C1). */
export interface LimitsConfig {
  readonly style: { readonly offered: ReadonlyArray<{ readonly id: string }> };
  readonly password: {
    readonly length: { readonly min: number; readonly max: number };
    readonly characters: { readonly simple: string };
  };
  readonly passphrase: {
    readonly words: { readonly min: number; readonly max: number };
    readonly wordLength: { readonly min: number; readonly max: number };
  };
}

/** The bounds a stored record is checked against, from the configuration; the same object serves the boot script and the app. */
export function storedLimits(config: LimitsConfig): StoredLimits {
  return {
    version: SETTINGS_SCHEMA_VERSION,
    themes: [...THEMES],
    styles: config.style.offered.map((style) => style.id),
    length: { min: config.password.length.min, max: config.password.length.max },
    words: { min: config.passphrase.words.min, max: config.passphrase.words.max },
    wordLength: { min: config.passphrase.wordLength.min, max: config.passphrase.wordLength.max },
    separators: config.password.characters.simple,
  };
}
