import { type Config, config } from "../config/validate.ts";
import { pick, type RandomSource, randomInt, webCrypto } from "./random.ts";
import { isWordListId, WORD_LISTS, type WordListId } from "./wordlists.ts";

export interface PassphraseOptions {
  wordList: WordListId;
  words: number;
  minWordLength: number;
  maxWordLength: number;
  number: boolean;
  symbol: boolean;
  excludeLookAlikes: boolean;
  separatorSymbol: string;
  numberDigits: number;
  symbolPosition: "both" | "before" | "after";
  capitalize: "off" | "random" | "every";
}

export class PassphraseOptionsError extends RangeError {
  override readonly name = "PassphraseOptionsError";
}
export class EmptyWordlistError extends RangeError {
  override readonly name = "EmptyWordlistError";
}

const c = config.passphrase;
export function defaultPassphraseSettings(deployment: Config = config): PassphraseOptions {
  const c = deployment.passphrase;
  const selected = c.wordLists.offered.find((list) => list.id === c.wordLists.default);
  if (!selected || !isWordListId(selected.id)) throw new PassphraseOptionsError("Invalid default word list");
  return {
    wordList: selected.id,
    words: c.words.default,
    minWordLength: selected.defaultMin,
    maxWordLength: selected.defaultMax,
    number: c.separator.number,
    symbol: c.separator.symbol,
    excludeLookAlikes: c.separator.excludeLookAlikes,
    separatorSymbol: c.separator.defaultSymbol,
    numberDigits: c.separator.numberDigits.default,
    symbolPosition: c.separator.symbolPosition as PassphraseOptions["symbolPosition"],
    capitalize: c.capitalize as PassphraseOptions["capitalize"],
  };
}
export const defaultPassphraseOptions = Object.freeze(defaultPassphraseSettings());

function validate(options: PassphraseOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new PassphraseOptionsError("Passphrase options must be an object");
  const keys = Object.keys(defaultPassphraseOptions);
  if (Object.keys(options).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(options, key)))
    throw new PassphraseOptionsError("Passphrase options contain missing or unknown keys");
  if (!isWordListId(options.wordList) || !c.wordLists.offered.some((list) => list.id === options.wordList))
    throw new PassphraseOptionsError("Unknown or unavailable word list");
  const bounds = WORD_LISTS[options.wordList];
  for (const [value, min, max] of [
    [options.words, c.words.min, c.words.max],
    [options.minWordLength, bounds.min, bounds.max],
    [options.maxWordLength, options.minWordLength, bounds.max],
    [options.numberDigits, c.separator.numberDigits.min, c.separator.numberDigits.max],
  ]) {
    if (!Number.isInteger(value) || (value as number) < (min as number) || (value as number) > (max as number))
      throw new PassphraseOptionsError("Passphrase counts and lengths must be integers within configured bounds");
  }
  if ([options.number, options.symbol, options.excludeLookAlikes].some((value) => typeof value !== "boolean"))
    throw new PassphraseOptionsError("Passphrase switches must be booleans");
  if (
    typeof options.separatorSymbol !== "string" ||
    (!["random", "random-unique"].includes(options.separatorSymbol) &&
      (options.separatorSymbol.length !== 1 || !config.password.characters.simple.includes(options.separatorSymbol)))
  )
    throw new PassphraseOptionsError("Passphrase separator must be a simple symbol or a random mode");
  if (
    !["both", "before", "after"].includes(options.symbolPosition) ||
    !["off", "random", "every"].includes(options.capitalize)
  )
    throw new PassphraseOptionsError("Invalid symbol position or capitalization mode");
}

/** Separator-only alphabet; words and digits are unaffected. */
export function separatorSymbols(options: PassphraseOptions): string[] {
  return [...config.password.characters.simple].filter(
    (char) => !options.excludeLookAlikes || !c.separator.lookAlikes.includes(char),
  );
}

/** Resolve an excluded fixed choice to the configured fixed default. */
export function effectiveSeparatorSymbol(options: PassphraseOptions): string {
  return options.excludeLookAlikes && c.separator.lookAlikes.includes(options.separatorSymbol)
    ? c.separator.defaultFixedSymbol
    : options.separatorSymbol;
}

// Immutable lists: cache each requested bounded range.
const pools = new Map<string, readonly string[]>();
function filteredWords(options: PassphraseOptions): readonly string[] {
  const key = `${options.wordList}:${options.minWordLength}:${options.maxWordLength}`;
  let pool = pools.get(key);
  if (!pool) {
    pool = Object.freeze(
      WORD_LISTS[options.wordList].words.filter(
        (word) => word.length >= options.minWordLength && word.length <= options.maxWordLength,
      ),
    );
    pools.set(key, pool);
  }
  return pool;
}
/** Preserve the current range on list changes, clamping both endpoints to real bounds. */
export function switchWordList(options: PassphraseOptions, wordList: WordListId): PassphraseOptions {
  const bounds = WORD_LISTS[wordList];
  const clamp = (value: number) => Math.max(bounds.min, Math.min(bounds.max, value));
  const next = {
    ...options,
    wordList,
    minWordLength: clamp(options.minWordLength),
    maxWordLength: clamp(options.maxWordLength),
  };
  validate(next);
  return next;
}

/** Real pool size for the meter; no randomness consumed. */
export function filteredWordCount(options: PassphraseOptions = defaultPassphraseOptions): number {
  validate(options);
  return filteredWords(options).length;
}

/** Independent word picks; unique symbols consume successive alphabet rounds. No partial result on error. */
export function generatePassphrase(
  options: PassphraseOptions = defaultPassphraseOptions,
  source: RandomSource = webCrypto,
): string {
  validate(options);
  const pool = filteredWords(options);
  if (!pool.length) throw new EmptyWordlistError("No words remain in the selected length range");
  const alphabet = separatorSymbols(options);
  const available = [...alphabet];
  const separatorSymbol = effectiveSeparatorSymbol(options);
  let result = "";
  for (let index = 0; index < options.words; index++) {
    if (index) {
      const nextSymbol = () => {
        if (!options.symbol) return "";
        if (separatorSymbol === "random") return pick(available, source);
        if (separatorSymbol === "random-unique") {
          if (!available.length) available.push(...alphabet);
          // At an odd-sized round boundary inside a gap, forbid its first symbol.
          const candidates = available.filter((value) => value !== first);
          const value = pick(candidates, source);
          available.splice(available.indexOf(value), 1);
          return value;
        }
        return separatorSymbol;
      };
      let first = "";
      if (!options.number || options.symbolPosition !== "after") {
        first = nextSymbol();
        result += first;
      }
      if (options.number) {
        for (let digit = 0; digit < options.numberDigits; digit++) result += String(randomInt(10, source));
        if (options.symbolPosition !== "before") result += nextSymbol();
      }
    }
    let word = pick(pool, source);
    if (options.capitalize === "every" || (options.capitalize === "random" && randomInt(2, source)))
      word = word.charAt(0).toUpperCase() + word.slice(1);
    result += word;
  }
  return result;
}
