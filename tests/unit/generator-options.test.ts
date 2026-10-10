import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { storedLimits } from "../../src/boot/storage.ts";
import { readStoredSettings } from "../../src/boot/stored-settings.ts";
import { config, validateConfig } from "../../src/config/validate.ts";
import { passphraseEntropy, passwordEntropy } from "../../src/core/entropy.ts";
import { defaultPassphraseOptions, generatePassphrase } from "../../src/core/passphrase.ts";
import {
  countPasswords,
  defaultCounts,
  defaultOptions,
  generatePassword,
  generatePasswords,
  type PasswordConfig,
  type PasswordOptions,
  planPassword,
} from "../../src/core/password.ts";
import { webCrypto, webCryptoFrom } from "../../src/core/random.ts";
import { defaultSettings, serializeSettings } from "../../src/ui/settings.ts";
import { chiSquarePValue, chiSquareStatistic } from "./chi-square.ts";
import { bufferedWebCrypto } from "./random-sources.ts";

const small: PasswordConfig = {
  ...config.password,
  length: { min: 1, max: 4, default: 3 },
  characters: { lowercase: "al", uppercase: "AB", numbers: "02", simple: "!", complex: "|" },
};
const optionsFor = (length: number): PasswordOptions => ({
  ...defaultOptions(small),
  length,
  counts: defaultCounts(small, length),
});

/** Independent brute force, including the existing Max-total adjustment. */
function validPasswords(options: PasswordOptions, c: PasswordConfig): string[] {
  const excluded = options.excludeLookAlikes ? c.lookAlikes : "";
  const sets = [
    ["lowercase", options.lowercase ? c.characters.lowercase : ""],
    ["uppercase", options.uppercase ? c.characters.uppercase : ""],
    ["numbers", options.numbers ? c.characters.numbers : ""],
    ["symbols", (options.simple ? c.characters.simple : "") + (options.complex ? c.characters.complex : "")],
  ]
    .filter(([, chars]) => chars)
    .map(([name, chars]) => ({
      name: name as keyof PasswordOptions["counts"],
      chars: [...(chars as string)].filter((char) => !excluded.includes(char)),
    }));
  const limits = sets.map(({ name }) => ({ ...options.counts[name] }));
  const maxSum = limits.reduce((sum, limit) => sum + limit.max, 0);
  if (maxSum < options.length) (limits[0] as { max: number }).max += options.length - maxSum;
  const all: string[] = [];
  function visit(prefix: string) {
    if (prefix.length === options.length) {
      if (
        sets.every(({ chars }, i) => {
          const count = [...prefix].filter((char) => chars.includes(char)).length;
          const limit = limits[i] as { min: number; max: number };
          return count >= limit.min && count <= limit.max;
        })
      )
        all.push(prefix);
      return;
    }
    for (const char of sets.flatMap(({ chars }) => chars)) visit(prefix + char);
  }
  visit("");
  const symbols = c.characters.simple + c.characters.complex;
  const constrained = all.filter((value) => !symbols.includes(value[0] as string));
  return options.dontStartWithSymbol && constrained.length ? constrained : all;
}

test("first-symbol rule count and entropy match brute force across lengths, masks, filters and Min/Max", () => {
  for (let length = 1; length <= 4; length++)
    for (let mask = 1; mask < 16; mask++)
      for (const excludeLookAlikes of [false, true])
        for (const dontStartWithSymbol of [false, true])
          for (const limits of [
            { min: 0, max: length },
            { min: 1, max: length },
            { min: 0, max: 0 },
            { min: 0, max: 1 },
            { min: length, max: length },
          ]) {
            const options = {
              ...optionsFor(length),
              lowercase: Boolean(mask & 1),
              uppercase: Boolean(mask & 2),
              numbers: Boolean(mask & 4),
              simple: Boolean(mask & 8),
              complex: Boolean(mask & 8),
              excludeLookAlikes,
              dontStartWithSymbol,
              counts: { lowercase: limits, uppercase: limits, numbers: limits, symbols: limits },
            };
            const selected = [1, 2, 4, 8].filter((bit) => mask & bit).length;
            if (selected * limits.min > length) continue;
            const expected = validPasswords(options, small);
            const plan = planPassword(options, small);
            assert.equal(countPasswords(plan), BigInt(expected.length));
            assert.deepEqual(passwordEntropy(options, small), {
              count: BigInt(expected.length),
              bits: Math.log2(expected.length),
            });
            assert.equal(
              plan.startSymbolRuleSkipped,
              dontStartWithSymbol && expected.every((value) => "!|".includes(value[0] as string)),
            );
          }
});

test("every two-type Min/Max combination agrees with brute force, including forced-symbol skips", () => {
  const tiny = { ...small, characters: { ...small.characters, lowercase: "a" } };
  for (let length = 1; length <= 4; length++)
    for (let lowerMin = 0; lowerMin <= length; lowerMin++)
      for (let lowerMax = lowerMin; lowerMax <= length; lowerMax++)
        for (let symbolMin = 0; symbolMin <= length - lowerMin; symbolMin++)
          for (let symbolMax = symbolMin; symbolMax <= length; symbolMax++) {
            const o = {
              ...optionsFor(length),
              uppercase: false,
              numbers: false,
              complex: false,
              counts: {
                ...defaultCounts(tiny, length),
                lowercase: { min: lowerMin, max: lowerMax },
                symbols: { min: symbolMin, max: symbolMax },
              },
            };
            const expected = validPasswords(o, tiny);
            assert.equal(countPasswords(planPassword(o, tiny)), BigInt(expected.length));
            assert.equal(passwordEntropy(o, tiny).count, BigInt(expected.length));
          }
});

test("rule skips only when normalized limits force symbols; preference survives and recovers", () => {
  for (const o of [
    { ...optionsFor(3), lowercase: false, uppercase: false, numbers: false },
    {
      ...optionsFor(3),
      uppercase: false,
      numbers: false,
      counts: { ...defaultCounts(small, 3), lowercase: { min: 0, max: 3 }, symbols: { min: 3, max: 3 } },
    },
    {
      ...optionsFor(3),
      uppercase: false,
      numbers: false,
      counts: { ...defaultCounts(small, 3), lowercase: { min: 0, max: 0 }, symbols: { min: 0, max: 3 } },
    },
  ]) {
    assert.equal(planPassword(o, small).startSymbolRuleSkipped, true);
    assert.equal(countPasswords(planPassword(o, small)), 8n);
    assert.equal(countPasswords(planPassword({ ...o, dontStartWithSymbol: false }, small)), 8n);
  }
  const raised = {
    ...optionsFor(3),
    uppercase: false,
    numbers: false,
    counts: { ...defaultCounts(small, 3), lowercase: { min: 0, max: 0 }, symbols: { min: 0, max: 1 } },
  };
  // Existing normalization raises lowercase Max to 2, making the rule feasible.
  assert.equal(planPassword(raised, small).dontStartWithSymbol, true);
  assert.equal(planPassword(raised, small).startSymbolRuleSkipped, false);
});

test("new options round-trip with strict shared settings validation", () => {
  for (const dontStartWithSymbol of [false, true])
    for (const separatorSymbol of ["-", "random", "random-unique"]) {
      const settings = defaultSettings(config);
      const changed = {
        ...settings,
        password: { ...settings.password, dontStartWithSymbol },
        passphrase: { ...settings.passphrase, separatorSymbol },
      };
      const text = serializeSettings(changed, config);
      assert.ok(text);
      assert.deepEqual(readStoredSettings(JSON.parse(text), storedLimits(config)), changed);
    }
  const text = serializeSettings(defaultSettings(config), config);
  assert.ok(text);
  for (const value of ["true", null, 1]) {
    const record = JSON.parse(text);
    record.settings.password.dontStartWithSymbol = value;
    assert.equal(readStoredSettings(record, storedLimits(config)), null);
  }
  const record = JSON.parse(text);
  record.settings.passphrase.separatorSymbol = "random-unique";
  record.settings.passphrase.words = 12;
  assert.ok(readStoredSettings(record, { ...storedLimits(config), separators: "!@" }));
});

test("config validates the boolean default and allows repeated rounds for unique separators", () => {
  const copy = structuredClone(config);
  Object.assign(copy.password, { dontStartWithSymbol: "true" });
  assert.throws(() => validateConfig(copy), /dontStartWithSymbol/);
  const short = structuredClone(config);
  short.password.characters.simple = "!@#$*()-";
  short.passphrase.separator.lookAlikes = [...short.passphrase.separator.lookAlikes]
    .filter((char) => short.password.characters.simple.includes(char))
    .join("");
  validateConfig(short);
  short.passphrase.words.max = 9;
  validateConfig(short);
  for (const defaultSymbol of ["random", "random-unique"]) {
    const random = structuredClone(config);
    random.passphrase.separator.defaultSymbol = defaultSymbol;
    validateConfig(random);
  }
});

test("new modes and forced first-character paths fail closed without crypto", () => {
  for (const source of [
    webCryptoFrom(undefined),
    webCryptoFrom({
      getRandomValues() {
        throw new Error("failed");
      },
    }),
  ]) {
    for (const separatorSymbol of ["random", "random-unique"])
      assert.throws(() => generatePassphrase({ ...defaultPassphraseOptions, separatorSymbol }, source), /Web Crypto/);
    assert.throws(() => generatePassword(optionsFor(4), small, source), /Web Crypto/);
    const forced = { ...small, characters: { ...small.characters, lowercase: "a", simple: "!" } };
    const o = { ...optionsFor(2), uppercase: false, numbers: false, complex: false };
    assert.throws(() => generatePassword(o, forced, source), /Web Crypto/);
  }
});

// Explore every accepted random decision with exact rational probabilities.
// Only the uniform primitive is substituted; pick, shuffle, composition and
// first-type weighting remain the real implementation. Rejection sampling is
// independently covered in random.test.ts.
class ChoiceNeeded extends Error {
  readonly bound: bigint;
  constructor(bound: bigint) {
    super("next choice");
    this.bound = bound;
  }
}
type Fraction = { n: bigint; d: bigint };
function add(a: Fraction, b: Fraction): Fraction {
  const gcd = (x: bigint, y: bigint): bigint => (y === 0n ? x : gcd(y, x % y));
  const n = a.n * b.d + b.n * a.d;
  const d = a.d * b.d;
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
function enumerateDecisions(run: (choose: (n: bigint) => bigint) => string): Map<string, Fraction> {
  const probabilities = new Map<string, Fraction>();
  function visit(choices: bigint[], denominator: bigint) {
    let index = 0;
    try {
      const value = run((n) => {
        if (index === choices.length) throw new ChoiceNeeded(n);
        return choices[index++] as bigint;
      });
      probabilities.set(value, add(probabilities.get(value) ?? { n: 0n, d: 1n }, { n: 1n, d: denominator }));
    } catch (error) {
      if (!(error instanceof ChoiceNeeded)) throw error;
      for (let choice = 0n; choice < error.bound; choice++) visit([...choices, choice], denominator * error.bound);
    }
  }
  visit([], 1n);
  return probabilities;
}
test("exhaustive decision trees give each valid password and passphrase exactly 1/count probability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "passgen-options-"));
  try {
    const core = join(import.meta.dirname, "../../src/core");
    const url = (path: string) => JSON.stringify(pathToFileURL(join(core, path)).href);
    let random = await readFile(join(core, "random.ts"), "utf8");
    const intStart = random.indexOf("export function randomInt(");
    const intEnd = random.indexOf("\n/**", intStart);
    random =
      random.slice(0, intStart) +
      `export function randomInt(n: number, source: RandomSource): number {
      return Number((source as unknown as { choose(n: bigint): bigint }).choose(BigInt(n)));
    }\n` +
      random.slice(intEnd);
    const bigStart = random.indexOf("export function randomBigInt(");
    const bigEnd = random.indexOf("\n/**", bigStart);
    random =
      random.slice(0, bigStart) +
      `export function randomBigInt(n: bigint, source: RandomSource): bigint {
      return (source as unknown as { choose(n: bigint): bigint }).choose(n);
    }\n` +
      random.slice(bigEnd);
    await writeFile(join(dir, "random.ts"), random);
    const code = (await readFile(join(core, "password.ts"), "utf8")).replace(
      '"../config/validate.ts"',
      url("../config/validate.ts"),
    );
    await writeFile(join(dir, "password.ts"), code);
    const fixture: typeof import("../../src/core/password.ts") = await import(
      pathToFileURL(join(dir, "password.ts")).href
    );
    const phraseCode = (await readFile(join(core, "passphrase.ts"), "utf8"))
      .replace('"../config/validate.ts"', url("../config/validate.ts"))
      .replace('import { WORDS } from "./wordlist.ts";', 'const WORDS = ["apple", "berry"];');
    await writeFile(join(dir, "passphrase.ts"), phraseCode);
    const entropyCode = (await readFile(join(core, "entropy.ts"), "utf8")).replace(
      '"../config/validate.ts"',
      url("../config/validate.ts"),
    );
    await writeFile(join(dir, "entropy.ts"), entropyCode.replace('"./separators.ts"', url("separators.ts")));
    const phrase: typeof import("../../src/core/passphrase.ts") = await import(
      pathToFileURL(join(dir, "passphrase.ts")).href
    );
    const entropy: typeof import("../../src/core/entropy.ts") = await import(
      pathToFileURL(join(dir, "entropy.ts")).href
    );
    for (const separatorSymbol of ["random", "random-unique"])
      for (const number of [false, true]) {
        const o = {
          ...defaultPassphraseOptions,
          words: number ? 2 : 3,
          number,
          separatorSymbol,
          capitalize: (number ? "random" : "off") as "random" | "off",
        };
        const distribution = enumerateDecisions((choose) =>
          phrase.generatePassphrase(
            o,
            Object.assign(() => {}, { choose }),
          ),
        );
        const n = BigInt(config.password.characters.simple.length);
        const expected = (number ? 4n * 100n * 4n : 8n) * n * (separatorSymbol === "random" ? n : n - 1n);
        assert.equal(BigInt(distribution.size), expected);
        assert.equal(entropy.passphraseEntropy(o).count, expected);
        for (const [value, probability] of distribution) {
          assert.deepEqual(probability, { n: 1n, d: expected });
          const punctuation = [...value].filter((char) => config.password.characters.simple.includes(char));
          if (separatorSymbol === "random-unique") assert.notEqual(punctuation[0], punctuation[1]);
        }
      }

    const tiny = { ...small, characters: { ...small.characters, lowercase: "a", numbers: "01" } };
    for (const o of [
      { ...optionsFor(2), uppercase: false, complex: false, counts: defaultCounts(tiny, 2), numbers: false },
      {
        ...optionsFor(2),
        uppercase: false,
        complex: false,
        counts: {
          ...defaultCounts(tiny, 2),
          lowercase: { min: 0, max: 2 },
          numbers: { min: 0, max: 2 },
          symbols: { min: 0, max: 2 },
        },
      },
      { ...optionsFor(3), uppercase: false, complex: false, counts: defaultCounts(tiny, 3) },
      {
        ...optionsFor(2),
        uppercase: false,
        complex: false,
        dontStartWithSymbol: false,
        counts: {
          ...defaultCounts(tiny, 2),
          lowercase: { min: 0, max: 1 },
          numbers: { min: 0, max: 1 },
          symbols: { min: 0, max: 2 },
        },
      },
    ]) {
      const expected = validPasswords(o, tiny);
      const distribution = enumerateDecisions((choose) =>
        fixture.generatePassword(
          o,
          tiny,
          Object.assign(() => {}, { choose }),
        ),
      );
      assert.deepEqual([...distribution.keys()].sort(), expected.sort());
      for (const probability of distribution.values())
        assert.deepEqual(probability, { n: 1n, d: BigInt(expected.length) });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function assertDistribution(observed: number[], expected: number[]) {
  assert.ok(expected.every((n) => n >= 50));
  const stat = chiSquareStatistic(observed, expected);
  const p = chiSquarePValue(stat, observed.length - 1);
  assert.ok(p >= 1e-9, `chi-square ${stat} on ${observed.length - 1} df, p=${p}`);
}

test("first-character and whole-password distributions match the exact constrained space", () => {
  const source = bufferedWebCrypto(webCrypto);
  for (const excludeLookAlikes of [false, true]) {
    const o = {
      ...optionsFor(4),
      excludeLookAlikes,
      complex: true,
      counts: { ...defaultCounts(small, 4), lowercase: { min: 0, max: 2 } },
    };
    const valid = validPasswords(o, small);
    const samples = 100_000;
    const observed = new Map(valid.map((value) => [value, 0]));
    const firsts = new Map<string, number>();
    const generated = generatePasswords(o, small, samples, source);
    for (const value of generated) {
      assert.ok(observed.has(value));
      observed.set(value, (observed.get(value) as number) + 1);
      firsts.set(value[0] as string, (firsts.get(value[0] as string) ?? 0) + 1);
    }
    assertDistribution(
      [...observed.values()],
      valid.map(() => samples / valid.length),
    );
    const chars = [...new Set(valid.map((value) => value[0] as string))];
    assertDistribution(
      chars.map((char) => firsts.get(char) ?? 0),
      chars.map((char) => (samples * valid.filter((value) => value[0] === char).length) / valid.length),
    );
  }
});

test("separator modes have uniform position marginals and uniform ordered pairs with real crypto", () => {
  const source = bufferedWebCrypto(webCrypto);
  const symbols = [...config.password.characters.simple];
  const n = symbols.length;
  const samples = 60_000;
  for (const separatorSymbol of ["random", "random-unique"])
    for (const number of [false, true]) {
      const positions = Array.from({ length: number ? 6 : 3 }, () => symbols.map(() => 0));
      const pairs = new Array<number>(n * n).fill(0);
      for (let i = 0; i < samples; i++) {
        const value = generatePassphrase({ ...defaultPassphraseOptions, words: 4, separatorSymbol, number }, source);
        const punctuation = [...value].filter((char) => symbols.includes(char));
        const chosen = punctuation;
        assert.equal(chosen.length, number ? 6 : 3);
        if (separatorSymbol === "random-unique") assert.equal(new Set(chosen).size, chosen.length);
        chosen.forEach((char, index) => {
          const row = positions[index] as number[];
          const cell = symbols.indexOf(char);
          row[cell] = (row[cell] as number) + 1;
        });
        const cell = symbols.indexOf(chosen[0] as string) * n + symbols.indexOf(chosen[1] as string);
        pairs[cell] = (pairs[cell] as number) + 1;
      }
      for (const position of positions)
        assertDistribution(
          position,
          symbols.map(() => samples / n),
        );
      const allowed = pairs.filter((_, index) => separatorSymbol === "random" || Math.floor(index / n) !== index % n);
      assertDistribution(
        allowed,
        allowed.map(() => samples / allowed.length),
      );
    }
});

test("separator entropy uses exact powers or falling factorials and ignores disabled symbols", () => {
  for (let words = 2; words <= 12; words++)
    for (const number of [false, true])
      for (const symbol of [false, true]) {
        const base = { ...defaultPassphraseOptions, separatorSymbol: "-", words, number, symbol };
        const fixed = passphraseEntropy(base).count;
        for (const separatorSymbol of ["random", "random-unique"]) {
          let choices = 1n;
          for (let i = 0; i < (words - 1) * (number ? 2 : 1); i++)
            choices *= BigInt(
              config.password.characters.simple.length -
                (separatorSymbol === "random-unique" ? i % config.password.characters.simple.length : 0),
            );
          const actual = passphraseEntropy({ ...base, separatorSymbol });
          assert.equal(actual.count, fixed * (symbol ? choices : 1n));
          assert.ok(Math.abs(actual.bits - Math.log2(Number(actual.count))) < 1e-10);
        }
      }
});
