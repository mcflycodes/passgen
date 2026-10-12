// The settings code: a short, typed text that carries every setting of both
// generators, the theme and the style to another browser, with no server,
// account, network request or URL. It holds settings only, never a
// generated value. This module is the format alone: pure functions with no
// DOM and no configuration. Whether a decoded code may be used on this page
// is decided by the stored-settings validator (src/ui/settings-code.ts),
// exactly as for saved settings.
//
// Format, version 1: "PG1-" then the body and two check characters, in
// Crockford base32 (0-9 and A-Z without I, L, O, U), grouped in fours with
// hyphens. Reading ignores case, spaces and hyphens, and takes I and L as 1
// and O as 0.
//
// The body is a bit string, five bits per character, most significant bit
// first. It lists only the settings that differ from BASELINE, the defaults
// this version shipped with, so the defaults encode as no entries at all.
// Each entry is a five-bit field number from FIELDS, in ascending order,
// followed by that field's value bits; a switch has no value bits, since
// its entry means "the opposite of the baseline". The last character is
// padded with zero bits. A field whose value equals its baseline is never
// written and is refused when read, so every settings record has exactly
// one code.
//
// The two check characters make the weighted sum of every character's value
// zero modulo the prime 1021: body character i weighs 33 + i, the check
// characters 32 and 1, and the sum starts from the version number. Weights
// are non-zero and differ from their neighbours, and every difference of two
// character values is below 1021, so any one changed character and any swap
// of two adjacent different characters changes the sum: both are always
// caught. Other typos are caught with odds of about 1020 in 1021.
//
// Adding a setting later (documented in docs/Configuration.md): give it the
// next unused field number with its baseline equal to its default at the
// time. Old codes never contain it, so they load with that default. An older
// page that meets the new field number refuses the code as coming from a
// newer version. Changing the meaning of an existing field or a baseline
// needs a new version prefix.

import type { StoredSettings } from "../boot/stored-settings.ts";

/** The format version this page writes and reads. */
export const SETTINGS_CODE_VERSION = 1;

/** The longest text that is examined at all; a valid code is far shorter. */
export const SETTINGS_CODE_TEXT_LIMIT = 200;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PRIME = 1021;
const GROUP = 4;
/** The body length up to which every body weight stays below the prime and above the check weights. */
const MAX_BODY = PRIME - 34;

/** Why a code was refused. */
export type SettingsCodeError = "empty" | "format" | "checksum" | "version";

export type DecodeResult =
  | { readonly ok: true; readonly settings: StoredSettings }
  | { readonly ok: false; readonly error: SettingsCodeError };

// Fixed lists, in code order. Never reorder them: values are indexes into them.
const THEMES = ["system", "light", "dark"] as const;
const KNOWN_STYLES = ["calm", "payload", "slate", "green", "purple"] as const;
/** A style id outside KNOWN_STYLES follows this marker as its own letters. */
const STYLE_ESCAPE = 7;
const STYLE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-";
const WORD_LISTS = ["orchard-long", "orchard-medium", "eff-large", "eff-short1", "eff-short2"] as const;
const POSITIONS = ["both", "before", "after"] as const;
const CAPITALIZE = ["off", "random", "every"] as const;
const COUNT_TYPES = ["lowercase", "uppercase", "numbers", "symbols"] as const;

/** Each word list's shipped default word lengths: the baseline for its Min and Max. */
const WORD_LENGTHS: Readonly<Record<(typeof WORD_LISTS)[number], readonly [number, number]>> = {
  "orchard-long": [5, 10],
  "orchard-medium": [5, 10],
  "eff-large": [5, 9],
  "eff-short1": [3, 5],
  "eff-short2": [5, 10],
};

/**
 * The defaults version 1 shipped with. Never change them: a code means these
 * plus its entries. A Max count's baseline is the password length, and a
 * word length's is the chosen list's entry in WORD_LENGTHS.
 */
export const BASELINE: StoredSettings = {
  theme: "system",
  style: "calm",
  password: {
    length: 20,
    lowercase: true,
    uppercase: true,
    numbers: true,
    simple: true,
    complex: true,
    excludeLookAlikes: false,
    dontStartWithSymbol: true,
    counts: {
      lowercase: { min: 1, max: 20 },
      uppercase: { min: 1, max: 20 },
      numbers: { min: 1, max: 20 },
      symbols: { min: 1, max: 20 },
    },
  },
  passphrase: {
    wordList: "orchard-long",
    words: 5,
    minWordLength: 5,
    maxWordLength: 10,
    number: true,
    symbol: true,
    excludeLookAlikes: false,
    separatorSymbol: "random",
    numberDigits: 2,
    symbolPosition: "both",
    capitalize: "off",
  },
};

type PasswordSwitch =
  | "lowercase"
  | "uppercase"
  | "numbers"
  | "simple"
  | "complex"
  | "excludeLookAlikes"
  | "dontStartWithSymbol";
type PassphraseSwitch = "number" | "symbol" | "excludeLookAlikes";

/** One field of the code: its number is its position in FIELDS. Value bits of 0 mean a switch. */
type Field =
  | { readonly kind: "theme" }
  | { readonly kind: "style" }
  | { readonly kind: "length" }
  | { readonly kind: "pwSwitch"; readonly name: PasswordSwitch }
  | { readonly kind: "count"; readonly type: (typeof COUNT_TYPES)[number]; readonly bound: "min" | "max" }
  | { readonly kind: "wordList" }
  | { readonly kind: "words" }
  | { readonly kind: "wordLength"; readonly bound: "min" | "max" }
  | { readonly kind: "ppSwitch"; readonly name: PassphraseSwitch }
  | { readonly kind: "separator" }
  | { readonly kind: "digits" }
  | { readonly kind: "position" }
  | { readonly kind: "capitalize" };

/** Version 1's fields. Append only; numbers 29 to 31 are unused and refused as a newer version. */
const FIELDS: readonly Field[] = [
  { kind: "theme" },
  { kind: "style" },
  { kind: "length" },
  { kind: "pwSwitch", name: "lowercase" },
  { kind: "pwSwitch", name: "uppercase" },
  { kind: "pwSwitch", name: "numbers" },
  { kind: "pwSwitch", name: "simple" },
  { kind: "pwSwitch", name: "complex" },
  { kind: "pwSwitch", name: "excludeLookAlikes" },
  { kind: "pwSwitch", name: "dontStartWithSymbol" },
  ...COUNT_TYPES.flatMap((type) => [
    { kind: "count", type, bound: "min" } as const,
    { kind: "count", type, bound: "max" } as const,
  ]),
  { kind: "wordList" },
  { kind: "words" },
  { kind: "wordLength", bound: "min" },
  { kind: "wordLength", bound: "max" },
  { kind: "ppSwitch", name: "number" },
  { kind: "ppSwitch", name: "symbol" },
  { kind: "ppSwitch", name: "excludeLookAlikes" },
  { kind: "separator" },
  { kind: "digits" },
  { kind: "position" },
  { kind: "capitalize" },
];
const FIELD_BITS = 5;

/** The fixed value width of each kind; a style and a separator are handled on their own. */
const WIDTH = {
  theme: 2,
  length: 8,
  count: 8,
  wordList: 3,
  words: 4,
  wordLength: 4,
  separator: 7,
  digits: 2,
  position: 2,
  capitalize: 2,
} as const;

class BitWriter {
  readonly bits: number[] = [];
  write(value: number, width: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** width) throw new RangeError("value out of range");
    for (let bit = width - 1; bit >= 0; bit -= 1) this.bits.push(Math.floor(value / 2 ** bit) % 2);
  }
}

class BitReader {
  private position = 0;
  private readonly bits: readonly number[];
  constructor(bits: readonly number[]) {
    this.bits = bits;
  }
  get remaining(): number {
    return this.bits.length - this.position;
  }
  /** The next `width` bits as a number, or null when fewer remain. */
  read(width: number): number | null {
    if (this.remaining < width) return null;
    let value = 0;
    for (let i = 0; i < width; i += 1) value = value * 2 + (this.bits[this.position++] as number);
    return value;
  }
}

/** The baseline Min and Max word lengths for a list id, or undefined for an id this version does not know. */
function wordLengths(wordList: string): readonly [number, number] | undefined {
  return (WORD_LISTS as readonly string[]).includes(wordList)
    ? WORD_LENGTHS[wordList as (typeof WORD_LISTS)[number]]
    : undefined;
}

function separatorValue(symbol: string): number {
  if (symbol === "random") return 0;
  if (symbol === "random-unique") return 1;
  const code = symbol.length === 1 ? symbol.charCodeAt(0) : -1;
  if (code < 33 || code > 126) throw new RangeError("separator not encodable");
  return code;
}

/** Writes the value bits of `field` to `w` and returns true, or returns false when it equals the baseline and is left out. */
function entryOf(field: Field, s: StoredSettings, w: BitWriter): boolean {
  const index = (list: readonly string[], value: string) => {
    const i = list.indexOf(value);
    if (i < 0) throw new RangeError("value not encodable");
    return i;
  };
  const p = s.password;
  const q = s.passphrase;
  switch (field.kind) {
    case "theme":
      if (s.theme === BASELINE.theme) return false;
      w.write(index(THEMES, s.theme), WIDTH.theme);
      return true;
    case "style": {
      if (s.style === BASELINE.style) return false;
      const known = (KNOWN_STYLES as readonly string[]).indexOf(s.style);
      if (known >= 0) {
        w.write(known, 3);
        return true;
      }
      const chars = [...s.style];
      if (chars.length < 1 || chars.length > 32) throw new RangeError("style not encodable");
      w.write(STYLE_ESCAPE, 3);
      w.write(chars.length - 1, 5);
      for (const char of chars) w.write(index([...STYLE_CHARS], char), 6);
      return true;
    }
    case "length":
      if (p.length === BASELINE.password.length) return false;
      w.write(p.length, WIDTH.length);
      return true;
    case "pwSwitch":
      return p[field.name] !== BASELINE.password[field.name];
    case "count": {
      const value = p.counts[field.type][field.bound];
      const base = field.bound === "max" ? p.length : BASELINE.password.counts[field.type].min;
      if (value === base) return false;
      w.write(value, WIDTH.count);
      return true;
    }
    case "wordList":
      if (q.wordList === BASELINE.passphrase.wordList) return false;
      w.write(index(WORD_LISTS, q.wordList), WIDTH.wordList);
      return true;
    case "words":
      if (q.words === BASELINE.passphrase.words) return false;
      w.write(q.words, WIDTH.words);
      return true;
    case "wordLength": {
      const bounds = wordLengths(q.wordList);
      if (!bounds) throw new RangeError("word list not encodable");
      const value = field.bound === "min" ? q.minWordLength : q.maxWordLength;
      if (value === bounds[field.bound === "min" ? 0 : 1]) return false;
      w.write(value, WIDTH.wordLength);
      return true;
    }
    case "ppSwitch":
      return q[field.name] !== BASELINE.passphrase[field.name];
    case "separator":
      if (q.separatorSymbol === BASELINE.passphrase.separatorSymbol) return false;
      w.write(separatorValue(q.separatorSymbol), WIDTH.separator);
      return true;
    case "digits":
      if (q.numberDigits === BASELINE.passphrase.numberDigits) return false;
      w.write(q.numberDigits, WIDTH.digits);
      return true;
    case "position":
      if (q.symbolPosition === BASELINE.passphrase.symbolPosition) return false;
      w.write(index(POSITIONS, q.symbolPosition), WIDTH.position);
      return true;
    case "capitalize":
      if (q.capitalize === BASELINE.passphrase.capitalize) return false;
      w.write(index(CAPITALIZE, q.capitalize), WIDTH.capitalize);
      return true;
  }
}

/** The version plus the weighted sum of the body characters, modulo the prime: body character i weighs 33 + i. */
function bodySum(body: readonly number[]): number {
  let sum = SETTINGS_CODE_VERSION;
  for (const [i, value] of body.entries()) sum = (sum + (33 + i) * value) % PRIME;
  return sum;
}

/** Whether `chars` (body then the two check characters, weighing 32 and 1) sum to zero. */
function checksumHolds(chars: readonly number[]): boolean {
  const [high, low] = chars.slice(-2) as [number, number];
  return (bodySum(chars.slice(0, -2)) + 32 * high + low) % PRIME === 0;
}

/**
 * The code for a settings record. The record must already have passed the
 * stored-settings validator; a value this version cannot express (a theme,
 * list or style id outside its alphabet, a number wider than its field)
 * throws a RangeError rather than producing a code that means something else.
 */
export function encodeSettingsCode(settings: StoredSettings): string {
  const w = new BitWriter();
  for (const [number, field] of FIELDS.entries()) {
    const entry = new BitWriter();
    if (entryOf(field, settings, entry)) {
      w.write(number, FIELD_BITS);
      w.bits.push(...entry.bits);
    }
  }
  while (w.bits.length % 5 !== 0) w.bits.push(0);
  const body: number[] = [];
  for (let i = 0; i < w.bits.length; i += 5)
    body.push(w.bits.slice(i, i + 5).reduce((value, bit) => value * 2 + bit, 0));
  if (body.length > MAX_BODY) throw new RangeError("code too long");
  const check = (PRIME - bodySum(body)) % PRIME;
  const text = [...body, Math.floor(check / 32), check % 32].map((value) => ALPHABET[value]).join("");
  const groups: string[] = [];
  for (let i = 0; i < text.length; i += GROUP) groups.push(text.slice(i, i + GROUP));
  return [`PG${SETTINGS_CODE_VERSION}`, ...groups].join("-");
}

/** The character values of a typed body, or null when a character is outside the alphabet. */
function characterValues(text: string): number[] | null {
  const values: number[] = [];
  for (const char of text) {
    const normal = char === "I" || char === "L" ? "1" : char === "O" ? "0" : char;
    const value = ALPHABET.indexOf(normal);
    if (value < 0) return null;
    values.push(value);
  }
  return values;
}

type Entry = number | string | true;

/** The entries of a body by field number, or the reason it is refused. */
function readEntries(body: readonly number[]): Map<number, Entry> | SettingsCodeError {
  const bits: number[] = [];
  for (const value of body) for (let bit = 4; bit >= 0; bit -= 1) bits.push(Math.floor(value / 2 ** bit) % 2);
  const r = new BitReader(bits);
  const entries = new Map<number, Entry>();
  // An entry is at least five bits; fewer remaining are padding.
  while (r.remaining >= FIELD_BITS) {
    const number = r.read(FIELD_BITS) as number;
    if (number >= FIELDS.length) return "version";
    if (entries.has(number)) return "format";
    const field = FIELDS[number] as Field;
    let value: Entry | null;
    if (field.kind === "pwSwitch" || field.kind === "ppSwitch") value = true;
    else if (field.kind === "style") {
      const known = r.read(3);
      if (known === null) return "format";
      if (known < KNOWN_STYLES.length) value = KNOWN_STYLES[known] as string;
      else if (known !== STYLE_ESCAPE) return "version";
      else {
        const length = r.read(5);
        if (length === null) return "format";
        let id = "";
        for (let i = 0; i <= length; i += 1) {
          const char = r.read(6);
          if (char === null || char >= STYLE_CHARS.length) return "format";
          id += STYLE_CHARS[char];
        }
        value = id;
      }
    } else value = r.read(WIDTH[field.kind]);
    if (value === null) return "format";
    // A list this version does not know may be one a newer version added.
    if (field.kind === "wordList" && (value as number) >= WORD_LISTS.length) return "version";
    entries.set(number, value);
  }
  return entries;
}

/** The record the entries describe, with the baseline for every field left out, or null when a value is outside its list. */
function buildSettings(entries: ReadonlyMap<number, Entry>): StoredSettings | null {
  const at = (field: number) => entries.get(field);
  const num = (field: number, base: number) => {
    const value = at(field);
    return typeof value === "number" ? value : base;
  };
  const flip = (field: number, base: boolean) => (at(field) === undefined ? base : !base);
  const pick = <T extends string>(list: readonly T[], field: number, base: T): T | undefined => {
    const value = at(field);
    return value === undefined ? base : list[value as number];
  };
  const bp = BASELINE.password;
  const bq = BASELINE.passphrase;
  const theme = pick(THEMES, 0, "system");
  const wordList = pick(WORD_LISTS, 18, "orchard-long");
  const symbolPosition = pick(POSITIONS, 27, bq.symbolPosition);
  const capitalize = pick(CAPITALIZE, 28, bq.capitalize);
  if (!theme || !wordList || !symbolPosition || !capitalize) return null;
  const length = num(2, bp.length);
  const [baseMin, baseMax] = WORD_LENGTHS[wordList];
  let separatorSymbol = bq.separatorSymbol;
  const separator = at(25);
  if (typeof separator === "number") {
    if (separator === 0) separatorSymbol = "random";
    else if (separator === 1) separatorSymbol = "random-unique";
    else if (separator >= 33 && separator <= 126) separatorSymbol = String.fromCharCode(separator);
    else return null;
  }
  const count = (i: number, type: (typeof COUNT_TYPES)[number]) => ({
    min: num(10 + 2 * i, bp.counts[type].min),
    max: num(11 + 2 * i, length),
  });
  const style = at(1);
  return {
    theme,
    style: typeof style === "string" ? style : BASELINE.style,
    password: {
      length,
      lowercase: flip(3, bp.lowercase),
      uppercase: flip(4, bp.uppercase),
      numbers: flip(5, bp.numbers),
      simple: flip(6, bp.simple),
      complex: flip(7, bp.complex),
      excludeLookAlikes: flip(8, bp.excludeLookAlikes),
      dontStartWithSymbol: flip(9, bp.dontStartWithSymbol),
      counts: {
        lowercase: count(0, "lowercase"),
        uppercase: count(1, "uppercase"),
        numbers: count(2, "numbers"),
        symbols: count(3, "symbols"),
      },
    },
    passphrase: {
      wordList,
      words: num(19, bq.words),
      minWordLength: num(20, baseMin),
      maxWordLength: num(21, baseMax),
      number: flip(22, bq.number),
      symbol: flip(23, bq.symbol),
      excludeLookAlikes: flip(24, bq.excludeLookAlikes),
      separatorSymbol,
      numberDigits: num(26, bq.numberDigits),
      symbolPosition,
      capitalize,
    },
  };
}

/** `text` without spaces and hyphens, in capitals; the form two codes are compared in. */
function compact(text: string): string {
  return text.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * The settings a typed code describes, or why it is refused. The result is
 * only well formed: whether this page offers its style and word list, and
 * whether its numbers are within this page's bounds, is for the
 * stored-settings validator to decide. Never throws.
 */
export function decodeSettingsCode(input: unknown): DecodeResult {
  if (typeof input !== "string" || input.length > SETTINGS_CODE_TEXT_LIMIT) return { ok: false, error: "format" };
  const text = input.trim().toUpperCase();
  if (text === "") return { ok: false, error: "empty" };
  const prefix = /^PG(\d{1,3})\s*-/.exec(text);
  if (!prefix) return { ok: false, error: "format" };
  if (Number(prefix[1]) !== SETTINGS_CODE_VERSION) return { ok: false, error: "version" };
  const chars = characterValues(compact(text.slice(prefix[0].length)));
  if (!chars || chars.length < 2 || chars.length - 2 > MAX_BODY) return { ok: false, error: "format" };
  if (!checksumHolds(chars)) return { ok: false, error: "checksum" };
  const entries = readEntries(chars.slice(0, -2));
  if (typeof entries === "string") return { ok: false, error: entries };
  const settings = buildSettings(entries);
  if (!settings) return { ok: false, error: "format" };
  // One record, one code: entries out of order, an entry that restates its
  // baseline, or non-zero padding all re-encode differently and are refused.
  let canonical: string;
  try {
    canonical = encodeSettingsCode(settings);
  } catch {
    return { ok: false, error: "format" };
  }
  const typed = chars.map((value) => ALPHABET[value]).join("");
  if (compact(canonical) !== `PG${SETTINGS_CODE_VERSION}${typed}`) return { ok: false, error: "format" };
  return { ok: true, settings };
}
