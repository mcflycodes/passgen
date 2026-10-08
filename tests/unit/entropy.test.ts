import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { config } from "../../src/config/validate.ts";
import {
  EntropyError,
  log2BigInt,
  passphraseBits,
  passphraseEntropy,
  passwordBits,
  passwordEntropy,
} from "../../src/core/entropy.ts";
import { defaultPassphraseOptions, filteredWordCount, PassphraseOptionsError } from "../../src/core/passphrase.ts";
import {
  countPasswords,
  defaultCounts,
  defaultOptions,
  LengthBelowTypesError,
  MinAboveMaxError,
  NoTypesSelectedError,
  planPassword,
} from "../../src/core/password.ts";
import { topBits, wordsSource } from "./random-sources.ts";

test("default anchors are pinned within 0.01 bits", () => {
  const password = passwordEntropy();
  assert.equal(password.count, countPasswords(planPassword(defaultOptions(config.password), config.password)));
  assert.ok(Math.abs(password.bits - Math.log2(Number(password.count))) < 0.01);
  assert.ok(Math.abs(password.bits - 130.93) < 0.01);
  assert.equal(filteredWordCount(), 7223);
  const phrase = passphraseEntropy();
  assert.equal(phrase.count, 7223n ** 5n * 100n ** 4n);
  assert.ok(Math.abs(phrase.bits - 90.67) < 0.01);
});

test("meter wrappers accept the foundation's plan/options signatures", () => {
  const pw: (plan: ReturnType<typeof planPassword>) => number = passwordBits;
  const pp: (options: typeof defaultPassphraseOptions) => number = passphraseBits;
  assert.equal(pw(planPassword(defaultOptions(config.password), config.password)), passwordEntropy().bits);
  assert.equal(pp(defaultPassphraseOptions), passphraseEntropy().bits);
  assert.throws(() => pp({ ...defaultPassphraseOptions, words: 0 }), PassphraseOptionsError);
  const impossible = {
    length: 4,
    pool: ["a"],
    types: [{ name: "lowercase" as const, characters: ["a"], min: 0, max: 0 }],
  };
  assert.throws(() => pw(impossible), EntropyError);
});

test("BigInt logarithm handles powers, adjacent integers and values beyond Number range", () => {
  for (const exponent of [0, 1, 52, 53, 800, 1024, 4096]) {
    const power = 1n << BigInt(exponent);
    assert.equal(log2BigInt(power), exponent);
    assert.ok(Math.abs(log2BigInt(3n * power) - (exponent + Math.log2(3))) < 1e-10);
    if (exponent > 52) {
      assert.ok(Math.abs(log2BigInt(power - 1n) - exponent) < 1e-10);
      assert.ok(Math.abs(log2BigInt(power + 1n) - exponent) < 1e-10);
    }
  }
  for (let count = 1n; count < 1000n; count++) assert.equal(log2BigInt(count), Math.log2(Number(count)));
  for (const count of [0n, -1n]) assert.throws(() => log2BigInt(count), EntropyError);
  const options = { ...defaultOptions(config.password), length: 128, counts: defaultCounts(config.password, 128) };
  const full = passwordEntropy(options);
  assert.ok(full.count > 2n ** 800n);
  assert.ok(Math.abs(full.bits - 128 * Math.log2(94)) < 0.01);
});

test("password entropy matches independent enumeration with filters and bounded counts", () => {
  const small = {
    ...config.password,
    length: { min: 1, max: 5, default: 4 },
    characters: { lowercase: "al", uppercase: "A", numbers: "01", simple: "!", complex: "?" },
  };
  for (const length of [2, 3, 4, 5])
    for (const excludeLookAlikes of [false, true])
      for (const min of [0, 1]) {
        const options = {
          ...defaultOptions(small),
          length,
          excludeLookAlikes,
          numbers: false,
          simple: false,
          complex: false,
          counts: {
            ...defaultCounts(small, length),
            lowercase: { min, max: length - 1 },
            uppercase: { min: 1, max: length },
          },
        };
        const alphabet = excludeLookAlikes ? ["a", "A"] : ["a", "l", "A"];
        let valid = 0;
        const enumerate = (prefix: string): void => {
          if (prefix.length === length) {
            const lowercase = Array.from(prefix).filter((char) => char !== "A").length;
            if (lowercase >= min && lowercase <= length - 1) valid++;
            return;
          }
          for (const char of alphabet) enumerate(prefix + char);
        };
        enumerate("");
        assert.deepEqual(passwordEntropy(options, small), { count: BigInt(valid), bits: Math.log2(valid) });
      }
});

test("invalid settings preserve the generators' typed errors", () => {
  const options = defaultOptions(config.password);
  assert.throws(
    () =>
      passwordEntropy({
        ...options,
        lowercase: false,
        uppercase: false,
        numbers: false,
        simple: false,
        complex: false,
      }),
    NoTypesSelectedError,
  );
  assert.throws(
    () => passwordEntropy({ ...options, counts: { ...options.counts, lowercase: { min: 20, max: 20 } } }),
    LengthBelowTypesError,
  );
  assert.throws(
    () => passwordEntropy({ ...options, counts: { ...options.counts, lowercase: { min: 2, max: 1 } } }),
    MinAboveMaxError,
  );
  for (const changes of [
    { words: NaN },
    { words: 1 },
    { minWordLength: 9, maxWordLength: 5 },
    { separatorSymbol: " " },
  ])
    assert.throws(() => passphraseEntropy({ ...defaultPassphraseOptions, ...changes }), PassphraseOptionsError);
});

test("enumeration covers all four types, merged symbols and automatic Max adjustment", () => {
  const small = {
    ...config.password,
    length: { min: 4, max: 4, default: 4 },
    characters: { lowercase: "al", uppercase: "AO", numbers: "02", simple: "!", complex: "|" },
  };
  const names = ["lowercase", "uppercase", "numbers", "symbols"] as const;
  for (let mask = 1; mask < 16; mask++)
    for (const excludeLookAlikes of [false, true]) {
      const selected = names.filter((_, index) => mask & (1 << index));
      const options = {
        ...defaultOptions(small),
        lowercase: selected.includes("lowercase"),
        uppercase: selected.includes("uppercase"),
        numbers: selected.includes("numbers"),
        simple: selected.includes("symbols"),
        complex: selected.includes("symbols"),
        excludeLookAlikes,
        counts: Object.fromEntries(names.map((name) => [name, { min: 1, max: 2 }])) as ReturnType<typeof defaultCounts>,
      };
      const sets = selected.map((name) => {
        const chars = name === "symbols" ? "!|" : small.characters[name];
        return Array.from(chars).filter((char) => !excludeLookAlikes || !"lO0|".includes(char));
      });
      const maxima = selected.map((_, index) => 2 + (index === 0 ? Math.max(0, 4 - 2 * selected.length) : 0));
      const alphabet = sets.flat();
      let valid = 0;
      const enumerate = (prefix: string): void => {
        if (prefix.length === 4) {
          const counts = sets.map((set) => Array.from(prefix).filter((char) => set.includes(char)).length);
          if (counts.every((count, index) => count >= 1 && count <= (maxima[index] as number))) valid++;
          return;
        }
        for (const char of alphabet) enumerate(prefix + char);
      };
      enumerate("");
      assert.deepEqual(passwordEntropy(options, small), { count: BigInt(valid), bits: Math.log2(valid) });
      assert.equal(passwordBits(planPassword(options, small)), Math.log2(valid));
    }
});

test("every real word filter and separator/case combination uses the configured space", () => {
  for (let minWordLength = 3; minWordLength <= 9; minWordLength++)
    for (let maxWordLength = minWordLength; maxWordLength <= 9; maxWordLength++)
      for (const number of [false, true])
        for (const symbol of [false, true])
          for (const capitalize of [false, true]) {
            const options = { ...defaultPassphraseOptions, minWordLength, maxWordLength, number, symbol, capitalize };
            const expected =
              5 * Math.log2(filteredWordCount(options)) +
              (number ? 4 * config.passphrase.separator.numberDigits * Math.log2(10) : 0) +
              (capitalize ? 5 : 0);
            assert.ok(Math.abs(passphraseEntropy(options).bits - expected) < 1e-10);
          }
});

test("synthetic wordlist checks independent word, digit and case spaces and empty pools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "passgen-entropy-"));
  try {
    const core = join(import.meta.dirname, "../../src/core");
    const url = (path: string): string => JSON.stringify(pathToFileURL(join(core, path)).href);
    const phraseCode = (await readFile(join(core, "passphrase.ts"), "utf8"))
      .replace('"../config/validate.ts"', url("../config/validate.ts"))
      .replace('"./random.ts"', url("random.ts"))
      .replace('import { WORDS } from "./wordlist.ts";', 'const WORDS = ["apple", "berry", "fig"];');
    await writeFile(join(dir, "passphrase.ts"), phraseCode);
    const entropyCode = (await readFile(join(core, "entropy.ts"), "utf8"))
      .replace('"../config/validate.ts"', url("../config/validate.ts"))
      .replace('"./password.ts"', url("password.ts"));
    await writeFile(join(dir, "entropy.ts"), entropyCode);
    const fixture: typeof import("../../src/core/entropy.ts") = await import(
      pathToFileURL(join(dir, "entropy.ts")).href
    );
    const phrase: typeof import("../../src/core/passphrase.ts") = await import(
      pathToFileURL(join(dir, "passphrase.ts")).href
    );
    for (const number of [false, true])
      for (const symbol of [false, true])
        for (const capitalize of [false, true]) {
          const options = { ...defaultPassphraseOptions, words: 2, number, symbol, capitalize };
          const outputs = new Set<string>();
          for (let first = 0; first < 2; first++)
            for (let second = 0; second < 2; second++)
              for (let n = 0; n < (number ? 100 : 1); n++)
                for (let cases = 0; cases < (capitalize ? 4 : 1); cases++) {
                  const draws = [
                    topBits(first, 1),
                    ...(capitalize ? [topBits(cases & 1, 1)] : []),
                    ...(number ? [topBits(Math.floor(n / 10), 4), topBits(n % 10, 4)] : []),
                    topBits(second, 1),
                    ...(capitalize ? [topBits((cases >> 1) & 1, 1)] : []),
                  ];
                  const source = wordsSource(draws);
                  outputs.add(phrase.generatePassphrase(options, source));
                  assert.equal(source.consumed, draws.length);
                }
          assert.deepEqual(fixture.passphraseEntropy(options), {
            count: BigInt(outputs.size),
            bits: Math.log2(outputs.size),
          });
        }
    assert.equal(
      fixture.passphraseEntropy({ ...defaultPassphraseOptions, minWordLength: 3, maxWordLength: 3 }).count,
      100n ** 4n,
    );
    assert.throws(
      () => fixture.passphraseEntropy({ ...defaultPassphraseOptions, minWordLength: 9, maxWordLength: 9 }),
      phrase.EmptyWordlistError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
