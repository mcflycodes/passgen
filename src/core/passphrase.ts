import { config } from "../config/validate.ts";
import { pick, type RandomSource, randomInt, webCrypto } from "./random.ts";
import { WORDS } from "./wordlist.ts";

export interface PassphraseOptions {
  words: number;
  minWordLength: number;
  maxWordLength: number;
  number: boolean;
  symbol: boolean;
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
export const defaultPassphraseOptions: Readonly<PassphraseOptions> = Object.freeze({
  words: c.words.default,
  minWordLength: c.wordLength.defaultMin,
  maxWordLength: c.wordLength.defaultMax,
  number: c.separator.number,
  symbol: c.separator.symbol,
  separatorSymbol: c.separator.defaultSymbol,
  numberDigits: c.separator.numberDigits.default,
  symbolPosition: c.separator.symbolPosition as PassphraseOptions["symbolPosition"],
  capitalize: c.capitalize as PassphraseOptions["capitalize"],
});

function validate(options: PassphraseOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new PassphraseOptionsError("Passphrase options must be an object");
  const keys = Object.keys(defaultPassphraseOptions);
  if (Object.keys(options).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(options, key)))
    throw new PassphraseOptionsError("Passphrase options contain missing or unknown keys");
  for (const [value, min, max] of [
    [options.words, c.words.min, c.words.max],
    [options.minWordLength, c.wordLength.min, c.wordLength.max],
    [options.maxWordLength, options.minWordLength, c.wordLength.max],
    [options.numberDigits, c.separator.numberDigits.min, c.separator.numberDigits.max],
  ]) {
    if (!Number.isInteger(value) || (value as number) < (min as number) || (value as number) > (max as number))
      throw new PassphraseOptionsError("Passphrase counts and lengths must be integers within configured bounds");
  }
  if ([options.number, options.symbol].some((value) => typeof value !== "boolean"))
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

// The wordlist is immutable: compute the bounded set of length ranges once.
const pools = new Map<string, readonly string[]>();
for (let min = c.wordLength.min; min <= c.wordLength.max; min++) {
  for (let max = min; max <= c.wordLength.max; max++) {
    pools.set(`${min}:${max}`, Object.freeze(WORDS.filter((word) => word.length >= min && word.length <= max)));
  }
}
function filteredWords(options: PassphraseOptions): readonly string[] {
  return pools.get(`${options.minWordLength}:${options.maxWordLength}`) as readonly string[];
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
  const available = Array.from(config.password.characters.simple);
  let result = "";
  for (let index = 0; index < options.words; index++) {
    if (index) {
      const nextSymbol = () => {
        if (!options.symbol) return "";
        if (options.separatorSymbol === "random") return pick(available, source);
        if (options.separatorSymbol === "random-unique") {
          if (!available.length) available.push(...config.password.characters.simple);
          // At an odd-sized round boundary inside a gap, forbid its first symbol.
          const candidates = available.filter((value) => value !== first);
          const value = pick(candidates, source);
          available.splice(available.indexOf(value), 1);
          return value;
        }
        return options.separatorSymbol;
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
