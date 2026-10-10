import { countPasswords, defaultOptions, PasswordError, planPassword } from "../core/password.ts";
import { symbolSlots, uniqueSymbolCount } from "../core/separators.ts";
import { MAX_WORD_LENGTH, MIN_WORD_LENGTH, WORDS } from "../core/wordlist.ts";
import shipped from "./config.json" with { type: "json" };

/** The per-type default counts (R11a): a null Max means the length. The JSON infers `null`; the type allows a number. */
export type CountDefaults = { min: number; max: number | null };
type Shipped = typeof shipped;
export type Config = Omit<Shipped, "password"> & {
  password: Omit<Shipped["password"], "counts"> & {
    counts: Record<"lowercase" | "uppercase" | "numbers" | "symbols", CountDefaults>;
  };
};
type Schema =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "number or null"
  | { [key: string]: Schema }
  | readonly [Schema];
const range = { min: "number", max: "number", default: "number" } as const;
/** Per-type default Min and Max counts (R11a); a null Max means the length. */
const count = { min: "number", max: "number or null" } as const;
const classes = {
  lowercase: "string",
  uppercase: "string",
  numbers: "string",
  simple: "string",
  complex: "string",
} as const;
const schema: Schema = {
  theme: "string",
  style: { default: "string", offered: [{ id: "string", label: "string" }] },
  text: { tagline: "string", intro: { enabled: "boolean", headline: "string", text: "string" } },
  // The page's two outward links (decision 0005, point 5): the source
  // repository in the header and the license in the footer. Each is an
  // https URL, or empty to leave that link out. They are the only addresses
  // the build may carry; `configuredLinks` tells the host-name checks so.
  links: { repoUrl: "string", licenseUrl: "string" },
  extraResults: "number",
  password: {
    length: range,
    characters: classes,
    enabled: { lowercase: "boolean", uppercase: "boolean", numbers: "boolean", simple: "boolean", complex: "boolean" },
    excludeLookAlikes: "boolean",
    dontStartWithSymbol: "boolean",
    lookAlikes: "string",
    counts: { lowercase: count, uppercase: count, numbers: count, symbols: count },
  },
  passphrase: {
    words: range,
    wordLength: { min: "number", max: "number", defaultMin: "number", defaultMax: "number" },
    separator: {
      number: "boolean",
      symbol: "boolean",
      defaultSymbol: "string",
      defaultFixedSymbol: "string",
      excludeLookAlikes: "boolean",
      lookAlikes: "string",
      numberDigits: range,
      symbolPosition: "string",
    },
    capitalize: "string",
  },
  meter: {
    bands: [{ minBits: "number", label: "string" }],
    passphraseWarningBits: "number",
    attacks: {
      fast: { hash: "string", gpus: "number", guessesPerSecond: "number", averageKeyspaceFraction: "number" },
      bcrypt: { cost: "number", guessesPerSecond: "number", gpus: "number" },
      argon2id: { parameters: "string", tagBytes: "number", guessesPerSecond: "number", gpus: "number" },
      online: { lockout: "string", attempts: "number" },
    },
    quantum: {
      current: "string",
      future: { enabled: "boolean", iterationSeconds: "number", processors: "number", assumptions: "string" },
    },
  },
};

/** Characters sites commonly reject as injection or parsing hazards; Complex only (R7). */
export const SIMPLE_HAZARDS = "'\"<>;\\&%=+";

/** Length caps, in code points, of the page text the build inserts (R4d). */
export const TEXT_LIMITS = { tagline: 80, headline: 60, text: 240, styleLabel: 24 } as const;

/** A style id names its folder under src/styles/ and its `data-style` value (R4a, C1). */
export const STYLE_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** The longest configured link, in UTF-16 code units. */
export const LINK_LIMIT = 200;

/**
 * An outward link the page may carry: empty, or an https URL with a host and
 * no credentials, written exactly as the URL parser serialises it, so what
 * the build inserts is what a browser will use. Anything else fails.
 */
function link(value: string, path: string): void {
  if (value === "") return;
  if (value.length > LINK_LIMIT) fail(path, `must be at most ${LINK_LIMIT} characters`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(path, "must be an https URL or empty");
  }
  if (url.protocol !== "https:" || url.hostname === "") fail(path, "must be an https URL or empty");
  if (url.username !== "" || url.password !== "") fail(path, "must not carry credentials");
  if (url.href !== value) fail(path, "must be written in its normalised form");
}

/** The non-empty configured links, the only addresses the build may carry (decision 0005). */
export function configuredLinks(config: Pick<Config, "links">): readonly string[] {
  return [config.links.repoUrl, config.links.licenseUrl].filter((url) => url !== "");
}

/** Plain text for the page: no control characters, no line or paragraph separators. */
function plainText(value: string, cap: number, path: string): void {
  if ([...value].length > cap) fail(path, `must be at most ${cap} characters`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) fail(path, "must not contain control characters");
}

function fail(path: string, rule: string): never {
  throw new Error(`Invalid config: ${path}: ${rule}`);
}
function shape(value: unknown, expected: Schema, path: string): void {
  if (expected === "number or null") {
    if (value !== null) shape(value, "number", path);
    return;
  }
  if (typeof expected === "string") {
    if (expected === "null" ? value !== null : typeof value !== expected) fail(path, `expected ${expected}`);
    if (expected === "number" && !Number.isFinite(value)) fail(path, "must be finite");
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(value)) fail(path, "expected array");
    for (const key of Object.keys(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) fail(`${path}.${key}`, "unknown key");
    }
    for (let index = 0; index < value.length; index++) shape(value[index], expected[0] as Schema, `${path}[${index}]`);
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "expected object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!Object.hasOwn(expected, key)) fail(`${path}.${key}`, "unknown key");
  for (const [key, child] of Object.entries(expected)) {
    if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing key");
    shape(record[key], child, `${path}.${key}`);
  }
}
function integer(value: number, min: number, max: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail(path, `must be an integer from ${min} to ${max}`);
}
function bounds(value: { min: number; max: number; default: number }, min: number, max: number, path: string): void {
  integer(value.min, min, max, `${path}.min`);
  integer(value.max, value.min, max, `${path}.max`);
  integer(value.default, value.min, value.max, `${path}.default`);
}
function unique(value: string, path: string): void {
  const chars = [...value]; // code points, so an astral character is one entry
  if (!chars.length) fail(path, "must not be empty");
  if (new Set(chars).size !== chars.length) fail(path, "duplicate characters");
}

/** Validates build data, without logging the supplied values. */
export function validateConfig(value: unknown): asserts value is Config {
  shape(value, schema, "config");
  const c = value as Config;
  const bandMinimums = [0, 40, 64, 80, 112, 128];
  const labels = ["Very weak", "Weak", "Moderate", "Strong", "Very strong", "Excellent"];
  if (c.meter.bands.length !== 6) fail("meter.bands", "requires six R17 bands");
  for (const [i, band] of c.meter.bands.entries()) {
    integer(band.minBits, bandMinimums[i] as number, Number.MAX_SAFE_INTEGER, `meter.bands[${i}].minBits`);
    if (
      band.label !== labels[i] ||
      (i === 0 ? band.minBits !== 0 : band.minBits <= (c.meter.bands[i - 1]?.minBits ?? 0))
    )
      fail("meter.bands", "must retain R17 labels and ordered thresholds");
  }
  const strongBits = c.meter.bands[3]?.minBits as number;
  if (!["system", "light", "dark"].includes(c.theme)) fail("theme", "unsupported theme");
  // Styles (R4a, C1): at least one offered, each with a well-formed id and a
  // short plain-text label, and the default among them. Whether each offered
  // style has a stylesheet that passes the R4b checks is the build's job.
  if (!c.style.offered.length) fail("style.offered", "at least one style must be offered");
  const ids = new Set<string>();
  for (const [i, { id, label }] of c.style.offered.entries()) {
    if (!STYLE_ID.test(id)) fail(`style.offered[${i}].id`, "must be a lowercase name of letters, digits and hyphens");
    if (ids.has(id)) fail(`style.offered[${i}].id`, "duplicate style");
    ids.add(id);
    if (!label.trim()) fail(`style.offered[${i}].label`, "must not be empty");
    plainText(label, TEXT_LIMITS.styleLabel, `style.offered[${i}].label`);
  }
  if (!ids.has(c.style.default)) fail("style.default", "must be one of the offered styles");
  // Page text (R4d): plain text with length caps. An empty tagline hides it;
  // an enabled intro needs both its headline and its paragraph.
  plainText(c.text.tagline, TEXT_LIMITS.tagline, "text.tagline");
  plainText(c.text.intro.headline, TEXT_LIMITS.headline, "text.intro.headline");
  plainText(c.text.intro.text, TEXT_LIMITS.text, "text.intro.text");
  if (c.text.intro.enabled && (!c.text.intro.headline.trim() || !c.text.intro.text.trim()))
    fail("text.intro", "an enabled intro needs a headline and a paragraph");
  link(c.links.repoUrl, "links.repoUrl");
  link(c.links.licenseUrl, "links.licenseUrl");
  integer(c.extraResults, 0, 20, "extraResults");
  bounds(c.password.length, 4, 128, "password.length");
  bounds(c.passphrase.words, 2, 12, "passphrase.words");
  const w = c.passphrase.wordLength;
  integer(w.min, MIN_WORD_LENGTH, MAX_WORD_LENGTH, "passphrase.wordLength.min");
  integer(w.max, w.min, MAX_WORD_LENGTH, "passphrase.wordLength.max");
  integer(w.defaultMin, w.min, w.max, "passphrase.wordLength.defaultMin");
  integer(w.defaultMax, w.defaultMin, w.max, "passphrase.wordLength.defaultMax");
  // Letters and digits are fixed classes. The two symbol classes may hold any
  // printable ASCII punctuation (never space, never non-ASCII) under R7, with
  // the injection and parsing hazards of R7 confined to Complex.
  const symbol = /^[!-/:-@[-`{-~]+$/;
  const allowed = {
    lowercase: /^[a-z]+$/,
    uppercase: /^[A-Z]+$/,
    numbers: /^[0-9]+$/,
    simple: symbol,
    complex: symbol,
  };
  const seen = new Set<string>();
  unique(c.password.lookAlikes, "password.lookAlikes");
  for (const [name, chars] of Object.entries(c.password.characters)) {
    const path = `password.characters.${name}`;
    if (/[^ -~]/.test(chars)) fail(path, "must use only the specified ASCII class");
    unique(chars, path);
    for (const char of chars) {
      if (seen.has(char)) fail(path, "overlapping character classes");
      seen.add(char);
    }
  }
  for (const [name, chars] of Object.entries(c.password.characters)) {
    if (!allowed[name as keyof typeof allowed].test(chars))
      fail(`password.characters.${name}`, "must use only the specified ASCII class");
    if (name === "simple" && [...chars].some((char) => SIMPLE_HAZARDS.includes(char)))
      fail(`password.characters.${name}`, "must not contain the injection and parsing hazards reserved for Complex");
    if (![...chars].some((char) => !c.password.lookAlikes.includes(char)))
      fail(`password.characters.${name}`, "look-alike exclusion empties class");
  }
  const minimumSizes = { lowercase: 20, uppercase: 20, numbers: 8, simple: 8, complex: 8 };
  for (const [name, minimum] of Object.entries(minimumSizes)) {
    if (c.password.characters[name as keyof typeof minimumSizes].length < minimum)
      fail(`password.characters.${name}`, `requires at least ${minimum} characters`);
  }
  for (const char of c.password.lookAlikes)
    if (!seen.has(char)) fail("password.lookAlikes", "exclusion must belong to a character class");
  if (c.password.enabled.complex && !c.password.enabled.simple) fail("password.enabled", "Complex implies Simple");
  const enabledTypes = (["lowercase", "uppercase", "numbers"] as const).filter((name) => c.password.enabled[name]);
  const symbolsEnabled = c.password.enabled.simple || c.password.enabled.complex;
  const types: Array<keyof typeof c.password.counts> = symbolsEnabled ? [...enabledTypes, "symbols"] : enabledTypes;
  if (!types.length) fail("password.enabled", "at least one class must be enabled");
  // Default counts (R11a, R11b): a Min from 0 up, a Max of null (the length)
  // or an integer from the Min to the longest length. The enabled types'
  // Mins must fit the shortest length and their Maxes must cover the default
  // length, so no adjustment is needed at the default length. Longer lengths
  // may raise a Max under R11b.
  for (const [name, { min, max }] of Object.entries(c.password.counts)) {
    integer(min, 0, c.password.length.max, `password.counts.${name}.min`);
    if (max !== null) integer(max, min, c.password.length.max, `password.counts.${name}.max`);
  }
  const minimums = types.reduce((sum, name) => sum + c.password.counts[name].min, 0);
  if (minimums > c.password.length.min)
    fail("password.length.min", "cannot satisfy the minimum counts of the enabled types");
  const maximums = types.reduce((sum, name) => sum + (c.password.counts[name].max ?? c.password.length.default), 0);
  if (maximums < c.password.length.default)
    fail("password.length.default", "the maximum counts of the enabled types must cover the default length");
  // Exact count of the passwords the defaults can produce (R11a); the
  // entropy of the defaults is log2 of it and must reach the Strong band.
  let valid: bigint;
  try {
    valid = countPasswords(planPassword(defaultOptions(c.password), c.password));
  } catch (error) {
    if (error instanceof PasswordError) fail("password", `defaults cannot be generated (${error.name})`);
    throw error;
  }
  if (valid < 1n << BigInt(strongBits))
    fail("password.length.default", "defaults must provide at least 80 bits and meet the configured Strong threshold");
  const s = c.passphrase.separator;
  unique(s.lookAlikes, "passphrase.separator.lookAlikes");
  for (const char of s.lookAlikes)
    if (!c.password.characters.simple.includes(char))
      fail("passphrase.separator.lookAlikes", "exclusion must belong to simple symbols");
  const filteredSymbols = [...c.password.characters.simple].filter((char) => !s.lookAlikes.includes(char));
  if (filteredSymbols.length < 2)
    fail("passphrase.separator.lookAlikes", "unique mode needs at least two remaining symbols");
  if (s.defaultFixedSymbol.length !== 1 || !filteredSymbols.includes(s.defaultFixedSymbol))
    fail("passphrase.separator.defaultFixedSymbol", "must be a remaining simple symbol");
  const symbolCount = s.excludeLookAlikes ? filteredSymbols.length : c.password.characters.simple.length;
  if (c.password.characters.simple.length < 2)
    fail("password.characters.simple", "unique mode needs at least two symbols");
  if (
    !["random", "random-unique"].includes(s.defaultSymbol) &&
    (s.defaultSymbol.length !== 1 || !c.password.characters.simple.includes(s.defaultSymbol))
  )
    fail("passphrase.separator.defaultSymbol", "must be one simple symbol or a random mode");
  if (s.numberDigits.min !== 1 || s.numberDigits.max !== 3)
    fail("passphrase.separator.numberDigits", "requires bounds 1–3");
  integer(s.numberDigits.default, 1, 3, "passphrase.separator.numberDigits.default");
  if (!["both", "before", "after"].includes(s.symbolPosition))
    fail("passphrase.separator.symbolPosition", "requires both, before or after");
  if (!["off", "random", "every"].includes(c.passphrase.capitalize))
    fail("passphrase.capitalize", "requires off, random or every");
  const filteredCount = WORDS.filter((word) => word.length >= w.defaultMin && word.length <= w.defaultMax).length;
  if (!filteredCount) fail("passphrase.wordLength", "default filter is empty");
  const gaps = c.passphrase.words.default - 1;
  let symbolBits = 0;
  if (s.symbol && ["random", "random-unique"].includes(s.defaultSymbol)) {
    const slots = symbolSlots(s);
    symbolBits =
      s.defaultSymbol === "random-unique"
        ? Math.log2(Number(uniqueSymbolCount(symbolCount, gaps, slots)))
        : gaps * slots * Math.log2(symbolCount);
  }
  const bits =
    symbolBits +
    c.passphrase.words.default * Math.log2(filteredCount) +
    (s.number ? (c.passphrase.words.default - 1) * s.numberDigits.default * Math.log2(10) : 0) +
    (c.passphrase.capitalize === "random" ? c.passphrase.words.default : 0);
  if (bits < strongBits)
    fail("passphrase.words.default", "defaults must provide at least 80 bits and meet the configured Strong threshold");
  const fast = c.meter.attacks.fast;
  if (fast.hash !== "NTLM" || fast.gpus !== 8 || fast.guessesPerSecond < 2.4e12 || fast.averageKeyspaceFraction !== 0.5)
    fail("meter.attacks.fast", "requires NTLM, 8 GPUs, at least 2.4e12 guesses/second and half the keyspace");
  integer(c.meter.passphraseWarningBits, 80, Number.MAX_SAFE_INTEGER, "meter.passphraseWarningBits");
  for (const name of ["bcrypt", "argon2id"] as const) {
    integer(c.meter.attacks[name].gpus, 1, Number.MAX_SAFE_INTEGER, `meter.attacks.${name}.gpus`);
    if (c.meter.attacks[name].guessesPerSecond <= 0) fail(`meter.attacks.${name}.guessesPerSecond`, "must be positive");
  }
  for (const [value, path] of [
    [c.meter.attacks.argon2id.parameters, "meter.attacks.argon2id.parameters"],
    [c.meter.attacks.online.lockout, "meter.attacks.online.lockout"],
    [c.meter.quantum.future.assumptions, "meter.quantum.future.assumptions"],
  ] as const) {
    plainText(value, 240, path);
    if (!value.trim()) fail(path, "must state the assumptions");
  }
  integer(c.meter.attacks.argon2id.tagBytes, 32, 32, "meter.attacks.argon2id.tagBytes");
  if (!c.meter.attacks.argon2id.parameters.includes(`${c.meter.attacks.argon2id.tagBytes}-byte tag`))
    fail("meter.attacks.argon2id.parameters", "must state the configured tag length");
  integer(c.meter.attacks.online.attempts, 1, 100, "meter.attacks.online.attempts");
  integer(c.meter.quantum.future.processors, 1, Number.MAX_SAFE_INTEGER, "meter.quantum.future.processors");
  if (c.meter.quantum.future.iterationSeconds <= 0) fail("meter.quantum.future.iterationSeconds", "must be positive");
  if (c.meter.attacks.bcrypt.cost !== 12) fail("meter.attacks.bcrypt.cost", "requires cost 12");
  if (c.meter.quantum.current !== "Current quantum hardware: practical password cracking has not been demonstrated")
    fail("meter.quantum.current", "must retain the approved quantum wording");
}

/**
 * The shipped configuration, as the page uses it. The build validates it
 * before any file is emitted (vite.config.ts) and the unit tests validate it
 * again, so the page itself does not: the validator and its messages stay
 * out of the bundle.
 */
export const config: Config = shipped;
