// The one decision about a stored settings record (R24 to R26), made by the
// boot script before the first paint and by the app when it starts. Both
// must accept exactly the same records: if the boot script applied a stored
// theme the app then refused, the page would paint in one theme and switch
// to another. So this module is pure (no DOM, no crypto, no imports) and the
// build inlines it into the boot script (scripts/lib/boot-script.ts) while
// src/ui/settings.ts imports it. `limits` carries the configured bounds, so
// the same checks run against the same numbers on both sides.
//
// Every check here is cheap: types, exact key sets, ranges, Min at most
// Max, the R8 symbol rule, at least one type, and the Min counts fitting
// the length. tests/unit/stored-settings.test.ts proves, over generated
// records, that nothing accepted here is later refused by the generators.
//
// Keep this file free of imports and of anything beyond plain functions
// and constants: the boot compiler refuses it otherwise.

/** The configured bounds a record is checked against (C1). */
export interface StoredLimits {
  /** The schema version the record must carry. */
  readonly version: number;
  /** The allowed themes (R4). */
  readonly themes: readonly string[];
  /** The ids of the offered styles (R4a). */
  readonly styles: readonly string[];
  /** Password length bounds. */
  readonly length: { readonly min: number; readonly max: number };
  /** Passphrase word count bounds. */
  readonly words: { readonly min: number; readonly max: number };
  /** Word length bounds of the list. */
  readonly wordLength: { readonly min: number; readonly max: number };
  /** The Simple symbols, the only separators a passphrase may use (R14). */
  readonly separators: string;
}

/** The Min and Max count of one character type (R11a). */
export interface StoredCount {
  readonly min: number;
  readonly max: number;
}

/** A record that passed every check. The shapes match the generators' option types. */
export interface StoredSettings {
  readonly theme: string;
  readonly style: string;
  readonly password: {
    readonly length: number;
    readonly lowercase: boolean;
    readonly uppercase: boolean;
    readonly numbers: boolean;
    readonly simple: boolean;
    readonly complex: boolean;
    readonly excludeLookAlikes: boolean;
    readonly counts: {
      readonly lowercase: StoredCount;
      readonly uppercase: StoredCount;
      readonly numbers: StoredCount;
      readonly symbols: StoredCount;
    };
  };
  readonly passphrase: {
    readonly words: number;
    readonly minWordLength: number;
    readonly maxWordLength: number;
    readonly number: boolean;
    readonly symbol: boolean;
    readonly separatorSymbol: string;
    readonly capitalize: boolean;
  };
}

/** Key names that reach an object's prototype chain or constructor; refused wherever they appear. */
export const HOSTILE_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/**
 * `value` as a plain object with exactly the given own keys, else null. An
 * array, a missing key, an extra key and a hostile key name all fail, so
 * only the named keys are ever read from the result.
 */
export function storedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length) return null;
  for (const key of own) if (HOSTILE_KEYS.includes(key) || !keys.includes(key)) return null;
  for (const key of keys) if (!Object.hasOwn(value, key)) return null;
  return value as Record<string, unknown>;
}

/** A safe integer from `min` to `max`. NaN, Infinity, a fraction and a numeric string all fail. */
export function storedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function storedBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function storedCount(value: unknown, length: number): StoredCount | null {
  const count = storedRecord(value, ["min", "max"]);
  if (!count) return null;
  const min = count.min;
  const max = count.max;
  if (!storedInteger(min, 0, length) || !storedInteger(max, 0, length) || min > max) return null;
  return { min, max };
}

function storedPassword(value: unknown, limits: StoredLimits): StoredSettings["password"] | null {
  const p = storedRecord(value, [
    "length",
    "lowercase",
    "uppercase",
    "numbers",
    "simple",
    "complex",
    "excludeLookAlikes",
    "counts",
  ]);
  if (!p) return null;
  const length = p.length;
  if (!storedInteger(length, limits.length.min, limits.length.max)) return null;
  const lowercase = p.lowercase;
  const uppercase = p.uppercase;
  const numbers = p.numbers;
  const simple = p.simple;
  const complex = p.complex;
  const excludeLookAlikes = p.excludeLookAlikes;
  if (!storedBoolean(lowercase) || !storedBoolean(uppercase) || !storedBoolean(numbers)) return null;
  if (!storedBoolean(simple) || !storedBoolean(complex) || !storedBoolean(excludeLookAlikes)) return null;
  // The R8 symbol rule and R9: Complex needs Simple, and some type must be on.
  if (complex && !simple) return null;
  if (!lowercase && !uppercase && !numbers && !simple) return null;
  const stored = storedRecord(p.counts, ["lowercase", "uppercase", "numbers", "symbols"]);
  if (!stored) return null;
  const lower = storedCount(stored.lowercase, length);
  const upper = storedCount(stored.uppercase, length);
  const digits = storedCount(stored.numbers, length);
  const symbols = storedCount(stored.symbols, length);
  if (!lower || !upper || !digits || !symbols) return null;
  // R11: the Min counts of the selected types must fit the length. The Max
  // counts need no check: the R11b adjustment raises them, never refuses.
  const minimums =
    (lowercase ? lower.min : 0) + (uppercase ? upper.min : 0) + (numbers ? digits.min : 0) + (simple ? symbols.min : 0);
  if (minimums > length) return null;
  return {
    length,
    lowercase,
    uppercase,
    numbers,
    simple,
    complex,
    excludeLookAlikes,
    counts: { lowercase: lower, uppercase: upper, numbers: digits, symbols },
  };
}

function storedPassphrase(value: unknown, limits: StoredLimits): StoredSettings["passphrase"] | null {
  const p = storedRecord(value, [
    "words",
    "minWordLength",
    "maxWordLength",
    "number",
    "symbol",
    "separatorSymbol",
    "capitalize",
  ]);
  if (!p) return null;
  const words = p.words;
  const minWordLength = p.minWordLength;
  const maxWordLength = p.maxWordLength;
  const number = p.number;
  const symbol = p.symbol;
  const separatorSymbol = p.separatorSymbol;
  const capitalize = p.capitalize;
  if (!storedInteger(words, limits.words.min, limits.words.max)) return null;
  if (!storedInteger(minWordLength, limits.wordLength.min, limits.wordLength.max)) return null;
  if (!storedInteger(maxWordLength, minWordLength, limits.wordLength.max)) return null;
  if (!storedBoolean(number) || !storedBoolean(symbol) || !storedBoolean(capitalize)) return null;
  if (typeof separatorSymbol !== "string" || separatorSymbol.length !== 1) return null;
  if (!limits.separators.includes(separatorSymbol)) return null;
  return { words, minWordLength, maxWordLength, number, symbol, separatorSymbol, capitalize };
}

/**
 * The settings in an already parsed stored value, or null when anything
 * about it is wrong (R26). The result is built from fresh objects; nothing
 * of `value` is returned as it is.
 */
export function readStoredSettings(value: unknown, limits: StoredLimits): StoredSettings | null {
  const envelope = storedRecord(value, ["version", "settings"]);
  if (!envelope || envelope.version !== limits.version) return null;
  const s = storedRecord(envelope.settings, ["theme", "style", "password", "passphrase"]);
  if (!s) return null;
  const theme = s.theme;
  const style = s.style;
  if (typeof theme !== "string" || !limits.themes.includes(theme)) return null;
  if (typeof style !== "string" || !limits.styles.includes(style)) return null;
  const password = storedPassword(s.password, limits);
  if (!password) return null;
  const passphrase = storedPassphrase(s.passphrase, limits);
  if (!passphrase) return null;
  return { theme, style, password, passphrase };
}

/**
 * The settings in a stored text, or null when the text is longer than
 * `textLimit`, not JSON, or fails `readStoredSettings`. Never throws.
 */
export function parseStoredText(text: unknown, textLimit: number, limits: StoredLimits): StoredSettings | null {
  if (typeof text !== "string" || text.length > textLimit) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return readStoredSettings(parsed, limits);
}
