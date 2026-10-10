// The one place the interface keeps its state, and the one place it is saved
// (R24 to R26, C3). Every user-changeable setting of both generators, plus
// the theme and style, lives in one plain, serialisable object. The panels
// read and write it through the store; nothing else holds settings.
//
// Saving (R24): pressing "Save as my default" writes one snapshot of this
// object to localStorage under one key; "Reset to defaults" removes it and
// restores the configured defaults. Nothing else ever writes: a change made
// after saving is not saved unless Save is pressed again, so a one-off tweak
// never becomes the default. Nothing but settings is ever written: no
// generated value is part of this object (R25), and the only text that is
// written is one the validator below has accepted, so whatever is in storage
// is also loadable.
//
// Loading (R26): the stored text is checked by the shared validator in
// src/boot/stored-settings.ts, the same code the boot script runs before
// the first paint, against the configuration's bounds, before any of it is
// used. One bad field discards
// all of it: a wrong type, an unknown key, a value out of range or below a
// security minimum, an unknown theme or style, a hostile key. The page then
// starts from the configured defaults and removes the text, since nothing
// could make it valid later. Fields are copied one by one into fresh objects,
// so nothing from the stored text, not even a key name, reaches the rest of
// the app unchecked.

import {
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_STORAGE_KEY,
  SETTINGS_TEXT_LIMIT,
  storedLimits,
  type Theme,
} from "../boot/storage.ts";
import {
  parseStoredText,
  readStoredSettings,
  type StoredLimits,
  type StoredSettings,
} from "../boot/stored-settings.ts";
import type { Config } from "../config/validate.ts";
import { defaultPassphraseOptions, filteredWordCount, type PassphraseOptions } from "../core/passphrase.ts";
import { defaultOptions, type PasswordOptions, planPassword } from "../core/password.ts";
import { byId } from "./dom.ts";

export type { Theme } from "../boot/storage.ts";

export interface Settings {
  readonly theme: Theme;
  readonly style: string;
  readonly password: PasswordOptions;
  readonly passphrase: PassphraseOptions;
}

export type Listener = (settings: Settings) => void;

export interface SettingsStore {
  /** The current settings. Treat as read-only; change them with `update`. */
  readonly current: Settings;
  /** Replaces the given top-level fields and notifies subscribers. */
  update(patch: Partial<Settings>): Settings;
  /** Calls `listener` after every update; returns the function that unsubscribes it. */
  subscribe(listener: Listener): () => void;
  /** A plain copy safe to serialise (JSON) or compare. */
  snapshot(): Settings;
}

/** The settings the page starts with when nothing valid is stored: the configured defaults (C1). */
export function defaultSettings(config: Config): Settings {
  return {
    theme: config.theme as Theme,
    style: config.style.default,
    password: defaultOptions(config.password),
    passphrase: { ...defaultPassphraseOptions },
  };
}

export function createSettingsStore(initial: Settings): SettingsStore {
  let current = initial;
  const listeners = new Set<Listener>();
  return {
    get current() {
      return current;
    },
    update(patch) {
      current = { ...current, ...patch };
      for (const listener of listeners) listener(current);
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot() {
      return structuredClone(current);
    },
  };
}

// ---------- Validation of stored text (R26) ----------
//
// The decision is made by the pure module src/boot/stored-settings.ts, which
// the build also inlines into the boot script, against the same bounds
// (`storedLimits`). The generators are consulted once more here as a
// defence in depth; tests/unit/stored-settings.test.ts proves over
// generated records that they never refuse what the shared checks accept.

/** The bounds of the configuration, built once per configuration object. */
let limitsCache: { config: Config; limits: StoredLimits } | undefined;
function limitsFor(config: Config): StoredLimits {
  if (limitsCache?.config !== config) limitsCache = { config, limits: storedLimits(config) };
  return limitsCache.limits;
}

/** A record the shared checks accepted, as the app's typed settings, or null if a generator still refuses it. */
function toSettings(stored: StoredSettings, config: Config): Settings | null {
  const password: PasswordOptions = {
    length: stored.password.length,
    lowercase: stored.password.lowercase,
    uppercase: stored.password.uppercase,
    numbers: stored.password.numbers,
    simple: stored.password.simple,
    complex: stored.password.complex,
    excludeLookAlikes: stored.password.excludeLookAlikes,
    dontStartWithSymbol: stored.password.dontStartWithSymbol,
    counts: {
      lowercase: { ...stored.password.counts.lowercase },
      uppercase: { ...stored.password.counts.uppercase },
      numbers: { ...stored.password.counts.numbers },
      symbols: { ...stored.password.counts.symbols },
    },
  };
  const passphrase: PassphraseOptions = { ...stored.passphrase };
  try {
    planPassword(password, config.password);
    if (filteredWordCount(passphrase) < 1) return null;
  } catch {
    return null;
  }
  return { theme: stored.theme as Theme, style: stored.style, password, passphrase };
}

/**
 * The settings in an already parsed stored value, or null when anything about
 * it is wrong (R26). The result is built from fresh objects; nothing of
 * `value` is returned as it is.
 */
export function validateStoredSettings(value: unknown, config: Config): Settings | null {
  const stored = readStoredSettings(value, limitsFor(config));
  return stored ? toSettings(stored, config) : null;
}

/**
 * The settings in a stored text, or null when the text is too long, not
 * JSON, or fails `validateStoredSettings`. Never throws.
 */
export function parseStoredSettings(text: unknown, config: Config): Settings | null {
  const stored = parseStoredText(text, SETTINGS_TEXT_LIMIT, limitsFor(config));
  return stored ? toSettings(stored, config) : null;
}

/**
 * The text to store for `settings`, or null when the settings are not in a
 * state worth keeping (a count field mid-edit, say): the text is accepted by
 * the same validator that reads it, so whatever is stored is loadable.
 */
export function serializeSettings(settings: Settings, config: Config): string | null {
  const text = JSON.stringify({ version: SETTINGS_SCHEMA_VERSION, settings });
  return parseStoredSettings(text, config) === null ? null : text;
}

// ---------- Storage (R24) ----------

/**
 * The saved-settings slot in the browser's storage. No method throws, and
 * nothing is written until `write` or `remove` is called: there is no probe,
 * so a visit that never presses Save or Reset never touches storage at all
 * (R24), apart from removing a stored record that fails validation (R26).
 */
export interface SettingsStorage {
  /** The stored text, or null when there is none. */
  read(): string | null;
  /** Stores `text`; false when the browser refused or dropped it (quota, private modes). */
  write(text: string): boolean;
  /** Removes the stored text; true when none is left afterwards. */
  remove(): boolean;
}

/**
 * localStorage behind the one key (R24, decision 0005: per origin, so another
 * domain or port has its own), or null when it cannot even be read: disabled,
 * denied or missing (some private modes, some embedded contexts). Whether it
 * accepts writes is found out only when one is attempted, by reading the
 * value back, so an old record can still be removed when saving has to stop.
 * `area` is for tests; it defaults to the page's localStorage.
 */
export function browserStorage(area: () => Storage = () => localStorage): SettingsStorage | null {
  let storage: Storage;
  try {
    storage = area();
    storage.getItem(SETTINGS_STORAGE_KEY);
  } catch {
    return null;
  }
  const read = (): string | null => {
    try {
      const text: unknown = storage.getItem(SETTINGS_STORAGE_KEY);
      return typeof text === "string" ? text : null;
    } catch {
      return null;
    }
  };
  // Remove only this app's obsolete schema, never unrelated browser data.
  const removeLegacy = (): boolean => {
    for (const key of ["passgen:settings:v1", "passgen:settings:v2"])
      if (storage.getItem(key) !== null) storage.removeItem(key);
    return ["passgen:settings:v1", "passgen:settings:v2"].every((key) => storage.getItem(key) === null);
  };
  return {
    read,
    write(text) {
      try {
        storage.setItem(SETTINGS_STORAGE_KEY, text);
        return removeLegacy() && storage.getItem(SETTINGS_STORAGE_KEY) === text;
      } catch {
        return false;
      }
    },
    remove() {
      try {
        storage.removeItem(SETTINGS_STORAGE_KEY);
        const legacyRemoved = removeLegacy();
        return legacyRemoved && storage.getItem(SETTINGS_STORAGE_KEY) === null;
      } catch {
        return false;
      }
    },
  };
}

/** The settings the page starts with, and whether they came from storage. */
export interface InitialSettings {
  readonly settings: Settings;
  /** True when valid saved settings were found and applied. */
  readonly stored: boolean;
}

/**
 * The valid stored settings, else the configured defaults (R24, R26). Stored
 * text that fails validation is removed: nothing could make it valid later.
 */
export function initialSettings(config: Config, storage: SettingsStorage | null): InitialSettings {
  const text = storage?.read() ?? null;
  if (storage && text !== null) {
    const settings = parseStoredSettings(text, config);
    if (settings) return { settings, stored: true };
    storage.remove();
  }
  return { settings: defaultSettings(config), stored: false };
}

// ---------- The Save and Reset buttons (R24) ----------

export const SAVE_HINT =
  "Keeps both generators' settings, the theme and the style as this browser's defaults. Later changes are not saved unless you save again. Nothing generated is ever stored.";
export const SAVE_UNAVAILABLE_HINT =
  "Saving is unavailable: this browser's local storage is disabled, full or blocked.";
export const SAVED_STATUS = "Saved as your default.";
export const RESET_STATUS = "Reset to defaults. Nothing is saved in this browser now.";
export const RESET_FAILED_STATUS = "Reset to defaults, but could not delete saved settings from this browser.";
export const SAVE_FAILED_STATUS = "Could not save: this browser's local storage is disabled, full or blocked.";
export const SAVE_INVALID_STATUS = "Could not save: fix the settings marked with an error first.";
/** How long the highlight and the status text stay (the feedback is also announced at once). */
export const SAVE_FEEDBACK_MS = 2000;

/**
 * Binds "Save as my default" and "Reset to defaults". Nothing is written
 * until Save is pressed: it writes one snapshot of the whole store, so a
 * later change is not saved unless Save is pressed again. Reset removes the
 * record and puts the configured defaults back in the store, then `onReset`
 * lets the panels show them. Each outcome is shown as a short status, which
 * a screen reader hears, and a highlight on the pressed button that fades
 * out (or, with reduced motion, simply ends). A browser whose storage cannot
 * be read says so in the hint from the start, and the Save button explains
 * it again when pressed; one that refuses the write explains it then.
 */
export function mountSaveControl(
  store: SettingsStore,
  config: Config,
  storage: SettingsStorage | null,
  onReset: () => void,
): void {
  const save = byId("save-settings", HTMLButtonElement);
  const reset = byId("reset-settings", HTMLButtonElement);
  const hint = byId("save-settings-hint", HTMLElement);
  const status = byId("save-settings-status", HTMLElement);
  hint.textContent = storage ? SAVE_HINT : SAVE_UNAVAILABLE_HINT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const feedback = (button: HTMLButtonElement, message: string, ok: boolean) => {
    clearTimeout(timer);
    for (const b of [save, reset]) b.classList.remove("is-done");
    // The status is replaced, not appended, so a repeated press is announced again.
    status.textContent = "";
    status.textContent = message;
    status.classList.toggle("is-error", !ok);
    if (ok) button.classList.add("is-done");
    timer = setTimeout(() => {
      button.classList.remove("is-done");
      status.textContent = "";
      status.classList.remove("is-error");
    }, SAVE_FEEDBACK_MS);
  };
  save.addEventListener("click", () => {
    const text = serializeSettings(store.current, config);
    if (text === null) {
      feedback(save, SAVE_INVALID_STATUS, false);
      return;
    }
    if (!storage?.write(text)) {
      hint.textContent = SAVE_UNAVAILABLE_HINT;
      feedback(save, SAVE_FAILED_STATUS, false);
      return;
    }
    feedback(save, SAVED_STATUS, true);
  });
  reset.addEventListener("click", () => {
    const removed = storage?.remove() ?? false;
    store.update(defaultSettings(config));
    onReset();
    feedback(reset, removed ? RESET_STATUS : RESET_FAILED_STATUS, removed);
  });
}
