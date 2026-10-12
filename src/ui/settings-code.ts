// "Get settings code" and "Apply settings code": carry the current settings
// to another browser as a short typed code (src/core/settings-code.ts has
// the format). Nothing here touches storage, the URL or the network. A code
// holds settings only, never a generated value, and no message here ever
// repeats what was typed, since a mistyped paste could be a password.
//
// Getting a code checks the current settings with the stored-settings
// validator, as Save does, so a code is only ever made from settings that
// could be saved. Applying a code decodes it and checks the result with the
// same validator, against this page's own bounds, styles and word lists,
// before anything changes; a refused code changes nothing. An applied code
// goes into the store and the panels show it, as Reset does, and the meter
// is computed from those settings as for any other change. Applying does not
// save: Save as my default keeps it.

import { SETTINGS_SCHEMA_VERSION } from "../boot/storage.ts";
import type { Config } from "../config/validate.ts";
import {
  decodeSettingsCode,
  encodeSettingsCode,
  longestSettingsCode,
  type SettingsCodeError,
} from "../core/settings-code.ts";
import { bindCopy } from "./copy.ts";
import { byId } from "./dom.ts";
import { reserveText } from "./reserved-text.ts";
import { type Settings, type SettingsStore, validateStoredSettings } from "./settings.ts";

export const CODE_HINT =
  "To use these settings in another browser, get a code here and apply it there. The code holds settings only, never a password, and is not saved.";
export const CODE_READY_STATUS = "Settings code ready. It holds settings only, never a password.";
export const CODE_INVALID_STATUS = "Could not make a code: fix the settings marked with an error first.";
export const CODE_APPLIED_STATUS = "Settings applied. Press Save as my default to keep them in this browser.";
export const CODE_ERROR_STATUS: Readonly<Record<SettingsCodeError | "unavailable", string>> = {
  empty: "Type or paste a settings code first.",
  format: "That is not a settings code. Codes start with PG1- and use letters and digits.",
  checksum: "That code has a typo. Check each character and try again.",
  version: "That code comes from a different version of PassGen and cannot be used here.",
  unavailable: "That code asks for settings this page does not offer. Nothing was changed.",
};

/** The settings as the validator sees a saved record; null when they could not be saved either. */
function validated(settings: Settings, config: Config): Settings | null {
  return validateStoredSettings({ version: SETTINGS_SCHEMA_VERSION, settings: structuredClone(settings) }, config);
}

/**
 * The code for `settings`, or null when they are not in a state worth
 * keeping (a count field mid-edit, say) or the code would not read back as
 * exactly these settings.
 */
export function settingsCode(settings: Settings, config: Config): string | null {
  const checked = validated(settings, config);
  if (!checked) return null;
  let code: string;
  try {
    code = encodeSettingsCode(checked);
  } catch {
    return null;
  }
  const back = readSettingsCode(code, config);
  return back.ok && JSON.stringify(back.settings) === JSON.stringify(checked) ? code : null;
}

export type ReadResult =
  | { readonly ok: true; readonly settings: Settings }
  | { readonly ok: false; readonly error: SettingsCodeError | "unavailable" };

/** The settings a typed code describes, checked against this page's bounds, or why it is refused. Never throws. */
export function readSettingsCode(text: unknown, config: Config): ReadResult {
  const decoded = decodeSettingsCode(text);
  if (!decoded.ok) return decoded;
  const settings = validateStoredSettings({ version: SETTINGS_SCHEMA_VERSION, settings: decoded.settings }, config);
  return settings ? { ok: true, settings } : { ok: false, error: "unavailable" };
}

/**
 * Binds the settings code controls. Get shows the code for the current
 * settings; any later change clears it, so a shown code always matches the
 * page. Apply (or Enter in the field) reads the typed code and, when it is
 * valid here, puts its settings in the store and calls `onApply` so the
 * panels show them. The status says what happened and is announced.
 */
export function mountSettingsCode(store: SettingsStore, config: Config, onApply: () => void): void {
  const get = byId("get-settings-code", HTMLButtonElement);
  const value = byId("settings-code-value", HTMLOutputElement);
  const copy = byId("copy-settings-code", HTMLButtonElement);
  const input = byId("settings-code-input", HTMLInputElement);
  const apply = byId("apply-settings-code", HTMLButtonElement);
  const status = byId("settings-code-status", HTMLElement);
  byId("settings-code-hint", HTMLElement).textContent = CODE_HINT;
  // The slot keeps the height of the longest code this page can show, so
  // showing any code moves nothing below it; a code is never cut off.
  reserveText(value, [longestSettingsCode(config.style.offered.map((style) => style.id))]);

  const say = (message: string, ok: boolean) => {
    // Replaced, not appended, so a repeated message is announced again.
    status.textContent = "";
    status.textContent = message;
    status.classList.toggle("is-error", !ok);
  };
  const show = (code: string) => {
    value.textContent = code;
    copy.disabled = code === "";
  };
  show("");
  store.subscribe(() => {
    show("");
    say("", true);
  });

  get.addEventListener("click", () => {
    const code = settingsCode(store.current, config);
    show(code ?? "");
    say(code ? CODE_READY_STATUS : CODE_INVALID_STATUS, code !== null);
  });
  bindCopy(copy, () => value.textContent ?? "", value);

  const applyCode = () => {
    const result = readSettingsCode(input.value, config);
    if (!result.ok) {
      input.setAttribute("aria-invalid", "true");
      say(CODE_ERROR_STATUS[result.error], false);
      return;
    }
    input.removeAttribute("aria-invalid");
    store.update(result.settings);
    onApply();
    say(CODE_APPLIED_STATUS, true);
  };
  apply.addEventListener("click", applyCode);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    applyCode();
  });
  input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
}
