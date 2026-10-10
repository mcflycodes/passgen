import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { config } from "../../src/config/validate.ts";
import { passphraseEntropy } from "../../src/core/entropy.ts";
import { bcryptPassphrasePrefixBits, passphraseMaxBytes } from "../../src/core/hash-entropy.ts";
import { defaultPassphraseOptions, generatePassphrase } from "../../src/core/passphrase.ts";
import { symbolSlots, uniqueSymbolCount } from "../../src/core/separators.ts";
import { topBits, wordsSource } from "./random-sources.ts";

function bruteSymbols(n: number, gaps: number, slots: number): bigint {
  let count = 0n;
  const counts = Array<number>(n).fill(0);
  function visit(sequence: number[]) {
    if (sequence.length === gaps * slots) {
      count++;
      return;
    }
    for (let symbol = 0; symbol < n; symbol++) {
      if (counts[symbol] !== Math.min(...counts)) continue;
      if (sequence.length % slots !== 0 && sequence.at(-1) === symbol) continue;
      counts[symbol] = (counts[symbol] as number) + 1;
      visit([...sequence, symbol]);
      counts[symbol] = (counts[symbol] as number) - 1;
    }
  }
  visit([]);
  return count;
}

test("unique count matches brute-force balanced prefixes including round boundaries within gaps", () => {
  for (let n = 2; n <= 4; n++)
    for (let gaps = 1; gaps <= 4; gaps++)
      for (const slots of [1, 2]) assert.equal(uniqueSymbolCount(n, gaps, slots), bruteSymbols(n, gaps, slots));
});

test("Random draws both slots independently and permits a repeated symbol", () => {
  const draw = (index: number) => topBits(index, 13);
  for (const second of [0, 1]) {
    const result = generatePassphrase(
      { ...defaultPassphraseOptions, words: 2 },
      wordsSource([draw(0), topBits(0, 4), topBits(0, 4), topBits(0, 4), topBits(second, 4), draw(0)]),
    );
    assert.ok(result.includes(`!00${config.password.characters.simple[second]}`));
  }
});

test("unique 22 slots obey prefix balance and have no within-gap repetition", () => {
  for (let trial = 0; trial < 100; trial++) {
    const result = generatePassphrase({ ...defaultPassphraseOptions, words: 12, separatorSymbol: "random-unique" });
    const symbols = [...result].filter((char) => config.password.characters.simple.includes(char));
    assert.equal(symbols.length, 22);
    const counts = new Map([...config.password.characters.simple].map((char) => [char, 0]));
    symbols.forEach((symbol, index) => {
      const before = counts.get(symbol) as number;
      assert.equal(before, Math.min(...counts.values()));
      counts.set(symbol, before + 1);
      if (index % 2) assert.notEqual(symbol, symbols[index - 1]);
    });
  }
});

class NeedChoice extends Error {
  readonly bound: number;
  constructor(bound: number) {
    super();
    this.bound = bound;
  }
}

/** Enumerate every actual decision and its probability, with two words and tiny alphabets. */
async function checkSmallWordlists(filteredOnly: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "passgen-options-v3-"));
  try {
    const core = join(import.meta.dirname, "../../src/core");
    const url = (name: string) => JSON.stringify(pathToFileURL(join(core, name)).href);
    await writeFile(
      join(dir, "random.ts"),
      `
      export const webCrypto = () => {};
      export function randomInt(n: number, source: any) { return source.choose(n); }
      export function pick(values: any[], source: any) { return values[randomInt(values.length, source)]; }
    `,
    );
    for (const alphabet of filteredOnly ? ["!@#", "!@#$"] : ["!@", "!@#"]) {
      const fixtureConfig = {
        ...config,
        password: { ...config.password, characters: { ...config.password.characters, simple: alphabet } },
        passphrase: {
          ...config.passphrase,
          separator: { ...config.passphrase.separator, lookAlikes: "!", defaultFixedSymbol: "@" },
        },
      };
      const phraseCode = (await readFile(join(core, "passphrase.ts"), "utf8"))
        .replace('import { config } from "../config/validate.ts";', `const config = ${JSON.stringify(fixtureConfig)};`)
        .replace('import { WORDS } from "./wordlist.ts";', 'const WORDS = ["apple", "berry"];');
      const phraseName = `phrase-${alphabet.length}.ts`;
      await writeFile(join(dir, phraseName), phraseCode);
      const entropyCode = (await readFile(join(core, "entropy.ts"), "utf8"))
        .replace('import { config } from "../config/validate.ts";', `const config = ${JSON.stringify(fixtureConfig)};`)
        .replace('"./passphrase.ts"', JSON.stringify(`./${phraseName}`))
        .replace('"./password.ts"', url("password.ts"))
        .replace('"./separators.ts"', url("separators.ts"));
      await writeFile(join(dir, `entropy-${alphabet.length}.ts`), entropyCode);
      const phrase: typeof import("../../src/core/passphrase.ts") = await import(
        pathToFileURL(join(dir, phraseName)).href
      );
      const entropy: typeof import("../../src/core/entropy.ts") = await import(
        pathToFileURL(join(dir, `entropy-${alphabet.length}.ts`)).href
      );
      const checkDistribution = (options: typeof defaultPassphraseOptions) => {
        let leaves = 0;
        const outputs = new Map<string, number>();
        function visit(choices: number[], probability: number) {
          let index = 0;
          try {
            const value = phrase.generatePassphrase(
              options,
              Object.assign(() => {}, {
                choose(n: number) {
                  if (index === choices.length) throw new NeedChoice(n);
                  return choices[index++];
                },
              }),
            );
            leaves++;
            outputs.set(value, (outputs.get(value) ?? 0) + probability);
          } catch (error) {
            if (!(error instanceof NeedChoice)) throw error;
            for (let choice = 0; choice < error.bound; choice++) visit([...choices, choice], probability / error.bound);
          }
        }
        visit([], 1);
        const actual = entropy.passphraseEntropy(options);
        assert.equal(actual.count, BigInt(outputs.size), JSON.stringify(options));
        assert.equal(leaves, outputs.size);
        for (const probability of outputs.values()) assert.ok(Math.abs(probability * outputs.size - 1) < 1e-10);
      };
      if (!filteredOnly)
        for (const separatorSymbol of ["!", "random", "random-unique"])
          for (const symbolPosition of ["both", "before", "after"] as const)
            for (const numberDigits of [1, 2, 3])
              for (const capitalize of ["off", "random", "every"] as const) {
                // Exercise rounds across a gap with an odd alphabet, separately below.
                const options = {
                  ...defaultPassphraseOptions,
                  words: 2,
                  separatorSymbol,
                  symbolPosition,
                  numberDigits,
                  capitalize,
                };
                checkDistribution(options);
              }
      if (filteredOnly) {
        for (const separatorSymbol of ["!", "@", "random", "random-unique"])
          for (const symbolPosition of ["both", "before", "after"] as const)
            for (const number of [false, true])
              checkDistribution({
                ...defaultPassphraseOptions,
                words: 2,
                numberDigits: 1,
                excludeLookAlikes: true,
                separatorSymbol,
                symbolPosition,
                number,
              });
        const filtered = {
          ...defaultPassphraseOptions,
          words: 4,
          number: false,
          excludeLookAlikes: true,
          separatorSymbol: "random-unique",
        };
        assert.equal(entropy.passphraseEntropy(filtered).count, 16n * bruteSymbols(alphabet.length - 1, 3, 1));
        checkDistribution(filtered);
        const both = { ...filtered, words: 3, number: true, numberDigits: 1 };
        assert.equal(entropy.passphraseEntropy(both).count, 8n * 100n * bruteSymbols(alphabet.length - 1, 2, 2));
        checkDistribution(both);
      }
      const options = {
        ...defaultPassphraseOptions,
        words: 4,
        numberDigits: 1,
        capitalize: "every" as const,
        separatorSymbol: "random-unique",
      };
      assert.equal(entropy.passphraseEntropy(options).count, 16n * 1000n * bruteSymbols(alphabet.length, 3, 2));
      if (!filteredOnly) checkDistribution(options);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("all options have exact entropy and uniform output probabilities on small wordlists", () =>
  checkSmallWordlists(false));
test("filtered options have exact entropy and uniform output probabilities on small wordlists", () =>
  checkSmallWordlists(true));

test("positions, digit lengths and capitalization have exact factors and byte lengths", () => {
  for (const number of [false, true])
    for (const symbol of [false, true])
      for (const symbolPosition of ["both", "before", "after"] as const)
        for (const numberDigits of [1, 2, 3])
          for (const capitalize of ["off", "random", "every"] as const) {
            const options = { ...defaultPassphraseOptions, number, symbol, symbolPosition, numberDigits, capitalize };
            const base = passphraseEntropy({ ...options, symbol: false, number: false, capitalize: "off" }).count;
            assert.equal(
              passphraseEntropy(options).count,
              base *
                (number ? 10n ** BigInt(numberDigits * 4) : 1n) *
                12n ** BigInt(symbolSlots(options) * 4) *
                (capitalize === "random" ? 32n : 1n),
            );
            const value = generatePassphrase(options);
            assert.ok(value.length <= passphraseMaxBytes(options));
            const words = value.split(/[^a-zA-Z]+/);
            if (capitalize === "every") assert.ok(words.every((word) => /^[A-Z]/.test(word)));
            if (capitalize === "off") assert.ok(words.every((word) => /^[a-z]+$/.test(word)));
          }
  const title = { ...defaultPassphraseOptions, words: 12, number: false, symbol: false, capitalize: "every" as const };
  const off = { ...title, capitalize: "off" as const };
  assert.ok(bcryptPassphrasePrefixBits(title) > bcryptPassphrasePrefixBits(off));
});

test("bcrypt handles one-digit separators and explicit title-case word boundaries", () => {
  const options = {
    ...defaultPassphraseOptions,
    words: 12,
    minWordLength: 9,
    maxWordLength: 9,
    numberDigits: 1,
    symbol: false,
  };
  const wordBits = Math.log2(Number(passphraseEntropy({ ...options, words: 2, number: false }).count)) / 2;
  assert.ok(Math.abs(bcryptPassphrasePrefixBits(options) - (7 * wordBits + 7 * Math.log2(10))) < 1e-10);
  assert.ok(
    Math.abs(bcryptPassphrasePrefixBits({ ...options, number: false, capitalize: "every" }) - 8 * wordBits) < 1e-10,
  );
});
