import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { config } from "../../src/config/validate.ts";
import {
  defaultPassphraseOptions,
  EmptyWordlistError,
  filteredWordCount,
  generatePassphrase,
  type PassphraseOptions,
  PassphraseOptionsError,
} from "../../src/core/passphrase.ts";
import { RandomUnavailableError, webCryptoFrom } from "../../src/core/random.ts";
import { WORDS } from "../../src/core/wordlist.ts";
import { neverSource, topBits, wordsSource } from "./random-sources.ts";

const defaults = {
  ...defaultPassphraseOptions,
  wordList: "eff-large" as const,
  maxWordLength: 9,
  separatorSymbol: "-",
};
const pool = WORDS.filter((word) => word.length >= 5);
const draw = (index: number) => topBits(index, 13);
test("real filter counts and default strength agree with R13–R15", () => {
  assert.equal(filteredWordCount({ ...defaults }), 7223);
  assert.ok(Math.abs(Math.log2(filteredWordCount(defaults)) - 12.82) < 0.01);
  assert.ok(5 * Math.log2(filteredWordCount(defaults)) + 4 * Math.log2(100) >= 80);
  for (let min = 3; min <= 9; min++)
    for (let max = min; max <= 9; max++)
      assert.equal(
        filteredWordCount({ ...defaults, minWordLength: min, maxWordLength: max }),
        WORDS.filter((word) => word.length >= min && word.length <= max).length,
      );
});
for (const [number, symbol, separator] of [
  [true, true, "-05-"],
  [true, false, "05"],
  [false, true, "-"],
  [false, false, ""],
] as const) {
  test(`separator number=${number}, symbol=${symbol}`, () => {
    const source = wordsSource([draw(0), ...(number ? [topBits(0, 4), topBits(5, 4)] : []), draw(1)]);
    assert.equal(
      generatePassphrase({ ...defaults, words: 2, number, symbol }, source),
      `${pool[0]}${separator}${pool[1]}`,
    );
    assert.equal(source.consumed, number ? 4 : 2);
  });
}
test("default five words have fresh independent numbers and leading zeroes", () => {
  const source = wordsSource([
    draw(0),
    ...[0, 1, 2, 3].flatMap((n) => [topBits(n, 4), topBits(9 - n, 4), draw(n + 1)]),
  ]);
  assert.equal(
    generatePassphrase(defaults, source),
    `${pool[0]}-09-${pool[1]}-18-${pool[2]}-27-${pool[3]}-36-${pool[4]}`,
  );
});
test("digits reject values outside 0–9 and can produce 99", () => {
  const source = wordsSource([draw(0), topBits(15, 4), topBits(9, 4), topBits(10, 4), topBits(9, 4), draw(1)]);
  assert.equal(generatePassphrase({ ...defaults, words: 2 }, source), `${pool[0]}-99-${pool[1]}`);
});
test("words repeat, and capitalize draws an independent bit per word", () => {
  const source = wordsSource([draw(0), topBits(1, 1), draw(0), topBits(0, 1)]);
  const word = pool[0] as string;
  assert.equal(
    generatePassphrase({ ...defaults, words: 2, number: false, capitalize: "random" as const }, source),
    `${word[0]?.toUpperCase()}${word.slice(1)}-${word}`,
  );
});
// The picker offers exactly the Simple symbols (R14), read from the configuration.
assert.equal(config.password.characters.simple.length, 12);
assert.ok(config.password.characters.simple.includes(defaults.separatorSymbol));
for (const symbol of config.password.characters.simple)
  test(`fixed symbol ${symbol} consumes no draw`, () => {
    assert.equal(
      generatePassphrase(
        { ...defaults, words: 2, number: false, separatorSymbol: symbol },
        wordsSource([draw(0), draw(0)]),
      ),
      `${pool[0]}${symbol}${pool[0]}`,
    );
  });
for (const words of [2, 12])
  test(`word count bound ${words}`, () => {
    assert.equal(
      generatePassphrase({ ...defaults, words, number: false }, wordsSource(new Array(words).fill(draw(0)))).split("-")
        .length,
      words,
    );
  });
test("word rejection excludes a draw past the pool", () => {
  assert.equal(
    generatePassphrase({ ...defaults, words: 2, number: false }, wordsSource([draw(8191), draw(0), draw(1)])),
    `${pool[0]}-${pool[1]}`,
  );
});
for (const [key, values] of Object.entries({
  words: [1, 13, 2.5, NaN, Infinity, "5"],
  minWordLength: [2, 10, 5.5, "5"],
  maxWordLength: [2, 10, 5.5, "9"],
  number: [0, null],
  symbol: [1, "true"],
  capitalize: [true, false, "yes", 1, null],
  symbolPosition: ["side", true, null],
  numberDigits: [0, 4, 1.5, "2", NaN],
  separatorSymbol: ["", "--", "~", "%", "+", "=", "&", " ", "é", null],
}))
  for (const value of values)
    test(`rejects invalid ${key}: ${String(value)}`, () => {
      const options = { ...defaults, [key]: value } as PassphraseOptions;
      assert.throws(() => generatePassphrase(options, neverSource), PassphraseOptionsError);
      assert.throws(() => filteredWordCount(options), PassphraseOptionsError);
    });
for (const value of [null, [], { ...defaults, unknown: true }, {}])
  test(`rejects malformed options ${JSON.stringify(value)}`, () => {
    assert.throws(() => generatePassphrase(value as PassphraseOptions, neverSource), PassphraseOptionsError);
  });
test("inverted filter fails before consuming randomness", () => {
  assert.throws(
    () => generatePassphrase({ ...defaults, minWordLength: 8, maxWordLength: 7 }, neverSource),
    PassphraseOptionsError,
  );
});
test("Web Crypto failure returns no partial result", () => {
  assert.throws(() => generatePassphrase(defaults, webCryptoFrom(undefined)), RandomUnavailableError);
  let draws = 0;
  assert.throws(
    () =>
      generatePassphrase(defaults, (out) => {
        if (++draws > 2) throw new RandomUnavailableError("source failed");
        out.fill(0);
      }),
    RandomUnavailableError,
  );
});
/**
 * The passphrase module with `WORDS` replaced by the given list, as an
 * isolated module fixture: the validated production list has words at every
 * length and never yields an empty or one-word pool.
 */
async function withWordlist<T>(
  words: readonly string[],
  run: (module: typeof import("../../src/core/passphrase.ts")) => Promise<T> | T,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "passgen-wordlist-"));
  try {
    const core = join(import.meta.dirname, "../../src/core");
    const code = (await readFile(join(core, "passphrase.ts"), "utf8"))
      .replace('"../config/validate.ts"', JSON.stringify(pathToFileURL(join(core, "../config/validate.ts")).href))
      .replace('"./random.ts"', JSON.stringify(pathToFileURL(join(core, "random.ts")).href))
      .replace(
        'import { isWordListId, WORD_LISTS, type WordListId } from "./wordlists.ts";',
        `import { isWordListId, WORD_LISTS as originalLists } from ${JSON.stringify(pathToFileURL(join(core, "wordlists.ts")).href)}; const WORD_LISTS = Object.fromEntries(Object.entries(originalLists).map(([id, list]) => [id, { ...list, words: ${JSON.stringify(words)} }]));`,
      );
    const path = join(dir, "passphrase.ts");
    await writeFile(path, code);
    return await run(await import(pathToFileURL(path).href));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("empty list raises a typed error without randomness", async () => {
  await withWordlist([], (empty) => {
    assert.equal(empty.filteredWordCount(), 0);
    assert.throws(() => empty.generatePassphrase(defaults, neverSource), empty.EmptyWordlistError);
    assert.equal(new EmptyWordlistError().name, "EmptyWordlistError");
  });
});
test("one-word pool: the only possible passphrase is produced, drawing one word per pick", async () => {
  await withWordlist(["apple"], (one) => {
    const options = { ...defaults, words: 3, number: false, capitalize: "off" as const };
    assert.equal(one.filteredWordCount(options), 1);
    const source = wordsSource([0, 0xffffffff, 0x80000000]);
    assert.equal(one.generatePassphrase(options, source), "apple-apple-apple");
    assert.equal(source.consumed, 3);
  });
});
test("one-word pool fails closed: no output with Web Crypto missing, not a function, or throwing (S1)", async () => {
  const broken: Array<[string, unknown]> = [
    ["undefined crypto", undefined],
    ["null crypto", null],
    ["crypto without getRandomValues", {}],
    ["getRandomValues that is not a function", { getRandomValues: "yes" }],
    [
      "getRandomValues that throws",
      {
        getRandomValues() {
          throw new Error("broken");
        },
      },
    ],
  ];
  await withWordlist(["apple"], (one) => {
    // Every variant of the request whose only randomness is the one-word pick.
    const variants = [
      { ...defaults, words: 2, number: false, capitalize: "off" as const },
      { ...defaults, words: 2, number: false, symbol: false, capitalize: "off" as const },
      { ...defaults, words: 12, number: false, capitalize: "off" as const },
    ];
    for (const [label, cryptoObject] of broken) {
      const source = webCryptoFrom(cryptoObject);
      for (const options of variants) {
        assert.throws(() => one.generatePassphrase(options, source), RandomUnavailableError, label);
      }
      // With separator numbers or capitalization the draws are not forced; those fail closed too.
      assert.throws(() => one.generatePassphrase({ ...defaults, words: 2 }, source), RandomUnavailableError, label);
      assert.throws(
        () => one.generatePassphrase({ ...defaults, words: 2, number: false, capitalize: "random" as const }, source),
        RandomUnavailableError,
        label,
      );
    }
    assert.throws(() => one.generatePassphrase(variants[0], neverSource), /neverSource/);
  });
});
test("the production list never yields a one-word pool, so the fixture above is the only way to reach it", () => {
  for (let min = 3; min <= 9; min++)
    for (let max = min; max <= 9; max++)
      assert.ok(filteredWordCount({ ...defaults, minWordLength: min, maxWordLength: max }) > 1);
});
