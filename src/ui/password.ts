// The password panel (R5 to R11b, R21, R22): wires the controls to the
// password generator in src/core/password.ts, shows the R11b adjustment live
// in the Max fields, and turns each core error into a message beside the
// result with generation disabled (R9, R11, R11b, S1). All state lives in the
// settings store; this module reads and writes `settings.password`.

import type { Config } from "../config/validate.ts";
import {
  applySymbolRule,
  CountRangeError,
  generatePassword,
  generatePasswords,
  LengthBelowTypesError,
  MinAboveMaxError,
  NoTypesSelectedError,
  normalizeCounts,
  PASSWORD_TYPE_NAMES,
  type PasswordCounts,
  type PasswordOptions,
  type PasswordTypeName,
  planPassword,
  SymbolRuleError,
  type TypeCount,
} from "../core/password.ts";
import { RandomUnavailableError } from "../core/random.ts";
import { bindCopy } from "./copy.ts";
import { bindRangePair, byId, describeCharacters, integerValue } from "./dom.ts";
import type { Meter } from "./meter.ts";
import type { ResultsBox } from "./results.ts";
import type { SettingsStore } from "./settings.ts";

export interface PasswordPanelDeps {
  readonly meter: Meter;
  readonly results: ResultsBox;
}

/** The mounted panel; `refresh` shows and generates from the store's options after something else changed them (Reset). */
export interface Panel {
  refresh(): void;
}

const TYPE_LABELS: Readonly<Record<PasswordTypeName, string>> = {
  lowercase: "Lowercase letters",
  uppercase: "Capital letters",
  numbers: "Numbers",
  symbols: "Symbols",
};

/** The message for a request the core refuses; never includes generated output (S6). */
export function passwordErrorMessage(error: unknown): string {
  if (error instanceof NoTypesSelectedError) return "Select at least one character type to generate a password.";
  if (error instanceof LengthBelowTypesError) {
    if (error.minimums === error.types)
      return `A ${error.length}-character password cannot include one of each of the ${error.types} selected types. Raise the length or clear a type.`;
    return `A ${error.length}-character password cannot hold the ${error.minimums} characters that the Min counts add up to. Raise the length or lower a Min.`;
  }
  if (error instanceof MinAboveMaxError)
    return `${TYPE_LABELS[error.type]}: Min ${error.min} is above Max ${error.max}. Lower the Min or raise the Max.`;
  if (error instanceof CountRangeError)
    return `${TYPE_LABELS[error.type]}: ${error.field === "min" ? "Min" : "Max"} must be a whole number from ${error.min} to ${error.max}.`;
  if (error instanceof SymbolRuleError) return "Complex symbols need Simple symbols. Turn Simple symbols on.";
  if (error instanceof RandomUnavailableError)
    return "This browser provides no secure random numbers, so nothing was generated.";
  return "The password could not be generated with these settings.";
}

export function mountPasswordPanel(store: SettingsStore, config: Config, deps: PasswordPanelDeps): Panel {
  const output = byId("pw-value", HTMLOutputElement);
  const copy = byId("pw-copy", HTMLButtonElement);
  const regenerate = byId("pw-regen", HTMLButtonElement);
  const notice = byId("pw-notice", HTMLElement);
  const range = byId("pw-length", HTMLInputElement);
  const number = byId("pw-length-number", HTMLInputElement);
  const checks = {
    lowercase: byId("pw-lowercase", HTMLInputElement),
    uppercase: byId("pw-uppercase", HTMLInputElement),
    numbers: byId("pw-numbers", HTMLInputElement),
    simple: byId("pw-simple", HTMLInputElement),
    complex: byId("pw-complex", HTMLInputElement),
    excludeLookAlikes: byId("pw-lookalikes", HTMLInputElement),
    dontStartWithSymbol: byId("pw-no-start-symbol", HTMLInputElement),
  } as const;
  const counts = Object.fromEntries(
    PASSWORD_TYPE_NAMES.map((name) => [
      name,
      { min: byId(`pw-${name}-min`, HTMLInputElement), max: byId(`pw-${name}-max`, HTMLInputElement) },
    ]),
  ) as Record<PasswordTypeName, { min: HTMLInputElement; max: HTMLInputElement }>;

  // Character class labels come from the configuration (R7, R7a, C1).
  for (const name of ["lowercase", "uppercase", "numbers", "simple", "complex"] as const)
    byId(`pw-${name}-chars`, HTMLElement).textContent = describeCharacters(config.password.characters[name]);
  byId("pw-lookalikes-chars", HTMLElement).textContent = describeCharacters(config.password.lookAlikes);

  const options = (): PasswordOptions => store.current.password;
  const set = (password: PasswordOptions): PasswordOptions => store.update({ password }).password;

  const selected = (name: PasswordTypeName, o: PasswordOptions): boolean =>
    name === "symbols" ? o.simple || o.complex : o[name];

  /**
   * Writes the options into the controls: checkboxes, counts, and which count
   * fields are enabled. Every count field shows the value the visible output
   * was generated with, including a Max the R11b adjustment raised, even
   * while that field has focus; a field holding something that is not a
   * whole number is left as typed, with generation stopped.
   */
  const reflect = (o: PasswordOptions) => {
    for (const name of [
      "lowercase",
      "uppercase",
      "numbers",
      "simple",
      "complex",
      "excludeLookAlikes",
      "dontStartWithSymbol",
    ] as const)
      checks[name].checked = o[name];
    for (const name of PASSWORD_TYPE_NAMES) {
      const fields = counts[name];
      const on = selected(name, o);
      fields.min.disabled = !on;
      fields.max.disabled = !on;
      fields.min.max = String(o.length);
      fields.max.max = String(o.length);
      for (const field of ["min", "max"] as const) {
        const value = o.counts[name][field];
        if (Number.isNaN(value)) continue;
        if (fields[field].value !== String(value)) fields[field].value = String(value);
      }
    }
  };

  const previousDescriptions = new Map<Element, string | null>();
  const clearInvalid = () => {
    for (const [field, description] of previousDescriptions) {
      if (description === null) field.removeAttribute("aria-describedby");
      else field.setAttribute("aria-describedby", description);
    }
    previousDescriptions.clear();
    for (const name of PASSWORD_TYPE_NAMES) {
      counts[name].min.removeAttribute("aria-invalid");
      counts[name].max.removeAttribute("aria-invalid");
    }
    number.removeAttribute("aria-invalid");
  };
  const markInvalid = (error: unknown) => {
    if (error instanceof CountRangeError) counts[error.type][error.field].setAttribute("aria-invalid", "true");
    if (error instanceof MinAboveMaxError) counts[error.type].min.setAttribute("aria-invalid", "true");
    if (error instanceof LengthBelowTypesError) {
      number.setAttribute("aria-invalid", "true");
      for (const name of PASSWORD_TYPE_NAMES)
        if (selected(name, options()) && options().counts[name].min > 0)
          counts[name].min.setAttribute("aria-invalid", "true");
    }
  };

  const fail = (error: unknown) => {
    output.textContent = "";
    copy.disabled = true;
    regenerate.disabled = true;
    notice.textContent = passwordErrorMessage(error);
    notice.hidden = false;
    markInvalid(error);
    for (const field of document.querySelectorAll('#password [aria-invalid="true"]')) {
      const description = field.getAttribute("aria-describedby");
      previousDescriptions.set(field, description);
      if (!(description ?? "").split(/\s+/).includes(notice.id))
        field.setAttribute("aria-describedby", [description, notice.id].filter(Boolean).join(" "));
    }
    deps.meter.update(null, error);
    deps.results.render(() => []);
  };

  /** Applies the R11b adjustment, generates, and shows the result or the reason there is none. */
  const render = () => {
    clearInvalid();
    let o = options();
    try {
      const adjusted = normalizeCounts(o, config.password);
      if (PASSWORD_TYPE_NAMES.some((name) => adjusted[name].max !== o.counts[name].max))
        o = set({ ...o, counts: adjusted });
      reflect(o);
      const plan = planPassword(o, config.password);
      output.textContent = generatePassword(o, config.password);
      copy.disabled = false;
      regenerate.disabled = false;
      notice.hidden = !plan.startSymbolRuleSkipped;
      notice.textContent = plan.startSymbolRuleSkipped
        ? "Don't start with a symbol is skipped: these settings require only symbols."
        : "";
      deps.meter.update({ kind: "password", plan });
      deps.results.render((count) => generatePasswords(o, config.password, count));
    } catch (error) {
      reflect(o);
      fail(error);
    }
  };

  const lengthPair = bindRangePair(range, number, (length) => {
    const o = options();
    // A Max at the old length means "no limit": it follows the length (R11a).
    // Any Max above the new length is brought down to it.
    const adjust = (count: TypeCount): TypeCount => ({
      min: count.min,
      max: count.max >= o.length ? length : Math.min(count.max, length),
    });
    const next: PasswordCounts = {
      lowercase: adjust(o.counts.lowercase),
      uppercase: adjust(o.counts.uppercase),
      numbers: adjust(o.counts.numbers),
      symbols: adjust(o.counts.symbols),
    };
    set({ ...o, length, counts: next });
    render();
  });

  for (const name of ["lowercase", "uppercase", "numbers", "excludeLookAlikes", "dontStartWithSymbol"] as const) {
    checks[name].addEventListener("change", () => {
      set({ ...options(), [name]: checks[name].checked });
      render();
    });
  }
  for (const name of ["simple", "complex"] as const) {
    checks[name].addEventListener("change", () => {
      set(applySymbolRule({ ...options(), [name]: checks[name].checked }, name));
      render();
    });
  }
  for (const name of PASSWORD_TYPE_NAMES) {
    for (const field of ["min", "max"] as const) {
      const input = counts[name][field];
      const read = () => {
        const value = integerValue(input);
        const o = options();
        if (value === null) {
          // Not a whole number: the core reports it as a CountRangeError.
          set({ ...o, counts: { ...o.counts, [name]: { ...o.counts[name], [field]: Number.NaN } } });
        } else {
          set({ ...o, counts: { ...o.counts, [name]: { ...o.counts[name], [field]: value } } });
        }
        render();
      };
      input.addEventListener("input", read);
      input.addEventListener("change", read);
    }
  }
  regenerate.addEventListener("click", () => render());
  bindCopy(copy, () => output.textContent ?? "", output);

  const refresh = () => {
    lengthPair.set(options().length);
    render();
  };
  refresh();
  return { refresh };
}
