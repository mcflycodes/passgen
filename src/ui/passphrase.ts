// The passphrase panel (R12 to R15, R21, R22): wires the controls to the
// passphrase generator in src/core/passphrase.ts and turns each core error
// into a message beside the result with generation disabled (R13, S1). All
// state lives in the settings store; this module reads and writes
// `settings.passphrase`.

import type { Config } from "../config/validate.ts";
import {
  EmptyWordlistError,
  effectiveSeparatorSymbol,
  generatePassphrase,
  type PassphraseOptions,
  PassphraseOptionsError,
  separatorSymbols,
  switchWordList,
} from "../core/passphrase.ts";
import { RandomUnavailableError } from "../core/random.ts";
import { symbolSlots } from "../core/separators.ts";
import { isWordListId, WORD_LISTS, wordListDescription } from "../core/wordlists.ts";
import { bindCopy } from "./copy.ts";
import { bindRangePair, byId, integerValue } from "./dom.ts";
import type { Meter } from "./meter.ts";
import type { Panel } from "./password.ts";
import { reserveText } from "./reserved-text.ts";
import type { ResultsBox } from "./results.ts";
import type { SettingsStore } from "./settings.ts";

export interface PassphrasePanelDeps {
  readonly meter: Meter;
  readonly results: ResultsBox;
}

/** The message for a request the core refuses; never includes generated output (S6). */
export function passphraseErrorMessage(error: unknown): string {
  if (error instanceof EmptyWordlistError) return "No words have a length in this range. Widen the word length.";
  if (error instanceof PassphraseOptionsError) return "These passphrase settings are outside the allowed limits.";
  if (error instanceof RandomUnavailableError)
    return "This browser provides no secure random numbers, so nothing was generated.";
  return "The passphrase could not be generated with these settings.";
}

export function mountPassphrasePanel(store: SettingsStore, config: Config, deps: PassphrasePanelDeps): Panel {
  const output = byId("pp-value", HTMLOutputElement);
  const copy = byId("pp-copy", HTMLButtonElement);
  const regenerate = byId("pp-regen", HTMLButtonElement);
  const notice = byId("pp-notice", HTMLElement);
  const range = byId("pp-words", HTMLInputElement);
  const number = byId("pp-words-number", HTMLInputElement);
  const minLength = byId("pp-min-length", HTMLInputElement);
  const maxLength = byId("pp-max-length", HTMLInputElement);
  const useNumber = byId("pp-number", HTMLInputElement);
  const lookAlikes = byId("pp-lookalikes", HTMLInputElement);
  const useSymbol = byId("pp-symbol", HTMLInputElement);
  const symbol = byId("pp-symbol-char", HTMLSelectElement);
  const capitalize = byId("pp-capitalize", HTMLSelectElement);
  const digits = byId("pp-number-digits", HTMLSelectElement);
  const position = byId("pp-symbol-position", HTMLSelectElement);
  const uniqueNote = byId("pp-unique-note", HTMLElement);
  const listSelect = document.getElementById("pp-word-list") as HTMLSelectElement | null;
  const description = byId("pp-word-list-description", HTMLElement);
  reserveText(
    description,
    config.passphrase.wordLists.offered.map(({ id }) => {
      if (!isWordListId(id)) throw new Error("Unavailable word list");
      return wordListDescription(id);
    }),
    { alternatives: true },
  );
  const lengthHint = byId("pp-length-hint", HTMLElement);

  const options = (): PassphraseOptions => store.current.passphrase;
  const set = (passphrase: PassphraseOptions) => store.update({ passphrase });

  const reflect = (o: PassphraseOptions) => {
    const bounds = WORD_LISTS[o.wordList];
    if (listSelect) listSelect.value = o.wordList;
    description.textContent = wordListDescription(o.wordList);
    lengthHint.textContent = `${bounds.min} to ${bounds.max} letters`;
    for (const input of [minLength, maxLength]) {
      input.min = String(bounds.min);
      input.max = String(bounds.max);
    }
    lookAlikes.checked = o.excludeLookAlikes;
    const alphabet = separatorSymbols(o);
    symbol.replaceChildren(
      ...[...alphabet, "random", "random-unique"].map((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value === "random" ? "Random" : value === "random-unique" ? "Random (unique)" : value;
        return option;
      }),
    );
    useNumber.checked = o.number;
    useSymbol.checked = o.symbol;
    capitalize.value = o.capitalize;
    digits.value = String(o.numberDigits);
    digits.disabled = !o.number;
    position.value = o.symbolPosition;
    position.disabled = !o.number || !o.symbol;
    uniqueNote.hidden = !(o.separatorSymbol === "random-unique" && symbolSlots(o) * (o.words - 1) > alphabet.length);
    symbol.value = o.separatorSymbol;
    symbol.disabled = !o.symbol;
    minLength.value = String(o.minWordLength);
    maxLength.value = String(o.maxWordLength);
  };

  const render = () => {
    let o = options();
    const separatorSymbol = effectiveSeparatorSymbol(o);
    if (separatorSymbol !== o.separatorSymbol) {
      o = { ...o, separatorSymbol };
      set(o);
    }
    reflect(o);
    try {
      output.textContent = generatePassphrase(o);
      copy.disabled = false;
      regenerate.disabled = false;
      notice.hidden = true;
      notice.textContent = "";
      deps.meter.update({ kind: "passphrase", options: o });
      deps.results.render((count) => Array.from({ length: count }, () => generatePassphrase(o)));
    } catch (error) {
      output.textContent = "";
      copy.disabled = true;
      regenerate.disabled = true;
      notice.textContent = passphraseErrorMessage(error);
      notice.hidden = false;
      deps.meter.update(null, error);
      deps.results.render(() => []);
    }
  };

  const wordsPair = bindRangePair(range, number, (words) => {
    set({ ...options(), words });
    render();
  });

  // Word length (R13): each field is clamped to the list's range; when they
  // cross, the field being edited wins and the other follows it.
  const clamp = (value: number) => {
    const bounds = WORD_LISTS[options().wordList];
    return Math.min(bounds.max, Math.max(bounds.min, value));
  };
  const readLengths = (edited: "min" | "max") => {
    const o = options();
    const minValue = integerValue(minLength);
    const maxValue = integerValue(maxLength);
    let min = clamp(minValue ?? o.minWordLength);
    let max = clamp(maxValue ?? o.maxWordLength);
    if (min > max) {
      if (edited === "min") max = min;
      else min = max;
    }
    set({ ...o, minWordLength: min, maxWordLength: max });
    render();
  };
  listSelect?.addEventListener("change", () => {
    if (
      !isWordListId(listSelect.value) ||
      !config.passphrase.wordLists.offered.some((list) => list.id === listSelect.value)
    )
      return;
    set(switchWordList(options(), listSelect.value));
    render();
  });
  minLength.addEventListener("change", () => readLengths("min"));
  maxLength.addEventListener("change", () => readLengths("max"));

  lookAlikes.addEventListener("change", () => {
    set({ ...options(), excludeLookAlikes: lookAlikes.checked });
    render();
  });
  useNumber.addEventListener("change", () => {
    set({ ...options(), number: useNumber.checked });
    render();
  });
  useSymbol.addEventListener("change", () => {
    set({ ...options(), symbol: useSymbol.checked });
    render();
  });
  symbol.addEventListener("change", () => {
    set({ ...options(), separatorSymbol: symbol.value });
    render();
  });
  capitalize.addEventListener("change", () => {
    set({ ...options(), capitalize: capitalize.value as PassphraseOptions["capitalize"] });
    render();
  });
  digits.addEventListener("change", () => {
    set({ ...options(), numberDigits: Number(digits.value) });
    render();
  });
  position.addEventListener("change", () => {
    set({ ...options(), symbolPosition: position.value as PassphraseOptions["symbolPosition"] });
    render();
  });
  regenerate.addEventListener("click", render);
  bindCopy(copy, () => output.textContent ?? "", output);

  const refresh = () => {
    wordsPair.set(options().words);
    render();
  };
  refresh();
  return { refresh };
}
