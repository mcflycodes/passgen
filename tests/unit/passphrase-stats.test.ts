// Pearson chi-square at approximate alpha 1e-9, with >=100 expected samples
// per cell. Fifteen assertions give an approximate false failure rate <=1.5e-8.
// Real Web Crypto is injected in batches; deterministic sources cover exact
// draw order and rejection paths in passphrase.test.ts. This detects gross
// selection bias, not arbitrarily small deviations from uniformity.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPassphraseOptions, generatePassphrase } from "../../src/core/passphrase.ts";
import { webCrypto } from "../../src/core/random.ts";
import { WORDS } from "../../src/core/wordlist.ts";
import { chiSquarePValue, chiSquareStatistic } from "./chi-square.ts";
import { bufferedWebCrypto } from "./random-sources.ts";

function uniform(counts: number[], samples: number): void {
  const statistic = chiSquareStatistic(counts, samples / counts.length);
  assert.ok(samples / counts.length >= 100);
  assert.ok(chiSquarePValue(statistic, counts.length - 1) >= 1e-9, `chi-square ${statistic}`);
}
test("word choice is uniform over a real length-filtered list (alpha 1e-9)", () => {
  const pool = WORDS.filter((word) => word.length === 9);
  const indexes = new Map(pool.map((word, index) => [word, index]));
  const counts = new Array<number>(pool.length).fill(0);
  const samples = pool.length * 100;
  const source = bufferedWebCrypto(webCrypto);
  const options = { ...defaultPassphraseOptions, words: 2, minWordLength: 9, maxWordLength: 9, number: false };
  for (let i = 0; i < samples / 2; i++)
    for (const word of generatePassphrase(options, source).split("-")) {
      const index = indexes.get(word);
      assert.notEqual(index, undefined);
      counts[index as number] = (counts[index as number] as number) + 1;
    }
  uniform(counts, samples);
});
test("both separator digit positions are uniform (alpha 1e-9)", () => {
  const counts = [new Array<number>(10).fill(0), new Array<number>(10).fill(0)];
  const source = bufferedWebCrypto(webCrypto);
  const samples = 10_000;
  for (let i = 0; i < samples; i++) {
    const separator = generatePassphrase({ ...defaultPassphraseOptions, words: 2 }, source).split("-")[1] as string;
    for (let digit = 0; digit < 2; digit++) {
      const row = counts[digit] as number[];
      const value = Number(separator[digit]);
      row[value] = (row[value] as number) + 1;
    }
  }
  for (const row of counts) uniform(row, samples);
});

test("capitalization is uniform at every word position (alpha 1e-9)", () => {
  const options = { ...defaultPassphraseOptions, words: 12, number: false, capitalize: true };
  const counts = Array.from({ length: options.words }, () => [0, 0]);
  const source = bufferedWebCrypto(webCrypto);
  const samples = 10_000;
  for (let trial = 0; trial < samples; trial++) {
    const words = generatePassphrase(options, source).split(options.separatorSymbol);
    assert.equal(words.length, options.words);
    for (let position = 0; position < options.words; position++) {
      const first = (words[position] as string).charAt(0);
      const index = first === first.toUpperCase() ? 1 : 0;
      const row = counts[position] as number[];
      row[index] = (row[index] as number) + 1;
    }
  }
  for (const row of counts) uniform(row, samples);
});
