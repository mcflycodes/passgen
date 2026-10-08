// Statistical tests for src/core/random.ts with the real Web Crypto source.
//
// Design
// ------
// Each test is a one-sided Pearson chi-square goodness-of-fit test against
// the uniform distribution, failing when the upper-tail p-value is below
// ALPHA = 1e-9. For a correct sampler the chance that a given assertion
// fails is therefore approximately 1e-9, and with 78 such assertions in this
// file the chance of a spurious failure per CI run is roughly 8e-8. Both
// figures are approximate: the chi-square distribution is the large-sample
// limit of the statistic, the assertions in one test share a sample, and the
// deep tail is where the approximation is least exact. The p-value itself is
// computed exactly for the chi-square distribution (regularized incomplete
// gamma, tests/unit/chi-square.ts), not read from a table or a normal
// approximation.
//
// Sample sizes give at least 50 expected observations per cell, so the
// chi-square approximation is sound, and about 1.6 million draws in total.
// Negative controls, biased samplers of the kind the rules forbid, must fail
// the very same tests with the same sizes, which shows the tests have the
// power to catch a real defect at this budget.
//
// Source: Web Crypto throughout. Most tests draw through `bufferedWebCrypto`,
// which fetches 1024 words per getRandomValues call and hands them out one at
// a time, because in Node each call costs about 10 microseconds and the suite
// would otherwise take tens of seconds. The sampler's arithmetic is identical
// either way; one test per function also runs on the production default to
// show the default is wired to the same code.
//
// What these tests can and cannot show: they detect gross bias, such as a
// wrong bit width, a missing rejection branch, or a modulo over a small word.
// The modulo bias of `word % n` on a full 32-bit word is around 2e-8 relative
// for n <= 128, far below what any practical sample can see. That case is
// covered by the deterministic tests in random.test.ts, which prove the
// rejection branch runs and the result is not the remainder.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MAX_RANDOM_INT,
  pick,
  type RandomSource,
  randomBigInt,
  randomInt,
  shuffle,
  webCrypto,
} from "../../src/core/random.ts";
import { chiSquarePValue, chiSquareStatistic } from "./chi-square.ts";
import { bufferedWebCrypto } from "./random-sources.ts";

/** Per-assertion false-failure probability. */
const ALPHA = 1e-9;
/** Draws per uniformity test. */
const SAMPLES = 50_000;
/** Web Crypto words, fetched in batches (see the header comment). */
const source = bufferedWebCrypto(webCrypto);
/** The 94 printable ASCII characters PassGen can use (R7), as a pick() target. */
const CHARACTERS = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join("");

function tally(n: number, draw: () => number, samples = SAMPLES): number[] {
  const counts = new Array<number>(n).fill(0);
  for (let i = 0; i < samples; i += 1) {
    const value = draw();
    assert.ok(Number.isInteger(value) && value >= 0 && value < n, `value ${value} out of [0, ${n})`);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/** Asserts the counts are consistent with a uniform distribution over their cells. */
function assertUniform(counts: readonly number[], samples: number, label: string): void {
  const expected = samples / counts.length;
  assert.ok(expected >= 50, `${label}: expected ${expected} per cell is too small for a chi-square test`);
  const stat = chiSquareStatistic(counts, expected);
  const p = chiSquarePValue(stat, counts.length - 1);
  assert.ok(
    p >= ALPHA,
    `${label}: chi-square ${stat.toFixed(1)} on ${counts.length - 1} df, p = ${p.toExponential(2)}`,
  );
}

/** Asserts the counts are NOT uniform: the same test as assertUniform must reject them. */
function assertBiased(counts: readonly number[], samples: number, label: string): void {
  const stat = chiSquareStatistic(counts, samples / counts.length);
  const p = chiSquarePValue(stat, counts.length - 1);
  assert.ok(
    p < ALPHA,
    `${label}: a biased sampler passed with chi-square ${stat.toFixed(1)}, p = ${p.toExponential(2)}`,
  );
}

describe("chi-square helper against reference values", () => {
  const cases: Array<[number, number, number]> = [
    // [stat, df, p]: textbook critical values and exact closed forms.
    [3.841, 1, 0.05],
    [18.307, 10, 0.05],
    [41.4465, 2, 1e-9], // df = 2 is exponential: p = exp(-stat / 2)
    [36, 1, 1.973e-9], // df = 1 is Z^2: p = 2 (1 - Phi(6))
    [10, 4, 6 * Math.exp(-5)], // df = 4: p = exp(-x/2) (1 + x/2)
    [20, 6, 61 * Math.exp(-10)], // df = 6: p = exp(-x/2) (1 + x/2 + x^2/8)
    [124.342, 100, 0.05],
    [40, 4, 21 * Math.exp(-20)], // deep tail, about 4.3e-8
  ];
  for (const [stat, df, p] of cases) {
    test(`p(${stat}, df ${df}) is about ${p}`, () => {
      const got = chiSquarePValue(stat, df);
      assert.ok(Math.abs(got - p) / p < 0.002, `got ${got}`);
    });
  }
});

describe("randomInt is uniform on [0, n) for each n (chi-square, alpha 1e-9)", () => {
  // Powers of two (no rejection), small primes, the character class sizes from
  // R7 (26, 10, 12, 20), the full set (94) and a few others, up to n = 1000
  // where each cell still gets 50 expected observations.
  for (const n of [2, 3, 5, 6, 7, 10, 12, 16, 20, 26, 36, 52, 62, 94, 100, 128, 255, 1000]) {
    test(`n = ${n}`, () => {
      assertUniform(
        tally(n, () => randomInt(n, source)),
        SAMPLES,
        `randomInt(${n})`,
      );
    });
  }

  test("n = 94 on the production default source", () => {
    assertUniform(
      tally(94, () => randomInt(94)),
      SAMPLES,
      "randomInt(94) with the default source",
    );
  });
});

describe("randomInt at the 32-bit boundary", () => {
  test("n = 2^32: every one of the 32 bits is set half the time", () => {
    const ones = new Array<number>(32).fill(0);
    for (let i = 0; i < SAMPLES; i += 1) {
      const value = randomInt(MAX_RANDOM_INT, source);
      for (let bit = 0; bit < 32; bit += 1) if ((value >>> bit) & 1) ones[bit] = (ones[bit] ?? 0) + 1;
    }
    for (let bit = 0; bit < 32; bit += 1) {
      assertUniform([ones[bit] as number, SAMPLES - (ones[bit] as number)], SAMPLES, `bit ${bit}`);
    }
  });

  test("n = 2^32: the top byte is uniform over 256 values", () => {
    const counts = tally(256, () => randomInt(MAX_RANDOM_INT, source) >>> 24, 256 * 200);
    assertUniform(counts, 256 * 200, "top byte");
  });

  test("n = 3 * 2^29 (31 bits, one quarter rejected): the top two bits are uniform over 0, 1, 2", () => {
    const n = 3 * 2 ** 29;
    assertUniform(
      tally(3, () => randomInt(n, source) >>> 29),
      SAMPLES,
      `randomInt(${n}) >>> 29`,
    );
  });

  test("n = 2^31 + 1 (32 bits, almost half rejected): results spread evenly across the range", () => {
    // Bucket the result into 8 buckets of 2^28 and one for the single value 2^31 (dropped).
    const n = 2 ** 31 + 1;
    const counts = new Array<number>(8).fill(0);
    let kept = 0;
    for (let i = 0; i < SAMPLES; i += 1) {
      const value = randomInt(n, source);
      assert.ok(value >= 0 && value <= 2 ** 31);
      if (value === 2 ** 31) continue;
      counts[value >>> 28] = (counts[value >>> 28] ?? 0) + 1;
      kept += 1;
    }
    assertUniform(counts, kept, `randomInt(${n}) >>> 28`);
  });
});

describe("randomBigInt is uniform on [0, n) (chi-square, alpha 1e-9)", () => {
  test("n = 1000 (one word, 10 bits, 2.4% rejected)", () => {
    assertUniform(
      tally(1000, () => Number(randomBigInt(1000n, source))),
      SAMPLES,
      "randomBigInt(1000)",
    );
  });

  test("n = 3 * 2^38 (two words, 40 bits, a quarter rejected): the top 10 bits are uniform over 768 values", () => {
    const n = 3n << 38n;
    assertUniform(
      tally(768, () => Number(randomBigInt(n, source) >> 30n)),
      SAMPLES,
      "randomBigInt(3 * 2^38) >> 30",
    );
  });

  test("n = 94^128 (839 bits, 27 words): the top 7 bits are uniform over the values that are always kept", () => {
    // n = 94^128 lies in [2^838, 2^839) and its top 7 bits are 126, so a
    // candidate whose top 7 bits are 0 to 125 is always below n and kept, and
    // each of those 126 cells is equally likely. Cell 126 is partly rejected
    // and cell 127 always, so both are left out of the test.
    const n = 94n ** 128n;
    assert.equal(n.toString(2).length, 839);
    const cells = Number(n >> 832n);
    assert.equal(cells, 126);
    const counts = new Array<number>(cells).fill(0);
    let samples = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const top = Number(randomBigInt(n, source) >> 832n);
      assert.ok(top >= 0 && top <= cells, "the top bits never exceed those of n");
      if (top === cells) continue;
      counts[top] = (counts[top] ?? 0) + 1;
      samples += 1;
    }
    assertUniform(counts, samples, "randomBigInt(94^128) top 7 bits");
  });
});

describe("pick is uniform over its collection", () => {
  test("over the 94 printable characters", () => {
    const counts = tally(94, () => pick(CHARACTERS, source).charCodeAt(0) - 33);
    assertUniform(counts, SAMPLES, "pick(94 characters)");
  });

  test("over a 7-element array, on the production default source", () => {
    const items = [0, 1, 2, 3, 4, 5, 6];
    assertUniform(
      tally(7, () => pick(items)),
      SAMPLES,
      "pick(7 items) with the default source",
    );
  });
});

describe("shuffle is uniform over orderings", () => {
  test("every permutation of 4 elements is equally likely (24 cells), on the production default source", () => {
    const trials = 24 * 1000;
    const counts = new Map<string, number>();
    for (let i = 0; i < trials; i += 1) {
      const key = shuffle([0, 1, 2, 3]).join("");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    assert.equal(counts.size, 24, "all 24 permutations appear");
    assertUniform([...counts.values()], trials, "permutations of 4");
  });

  test("each of 10 elements lands in each position equally often", () => {
    const m = 10;
    const trials = 20_000;
    const positions = Array.from({ length: m }, () => new Array<number>(m).fill(0));
    const input = Array.from({ length: m }, (_, i) => i);
    for (let t = 0; t < trials; t += 1) {
      const out = shuffle(input, source);
      for (let position = 0; position < m; position += 1) {
        const row = positions[out[position] as number] as number[];
        row[position] = (row[position] ?? 0) + 1;
      }
    }
    assert.deepEqual(
      input,
      Array.from({ length: m }, (_, i) => i),
      "input not mutated",
    );
    for (let item = 0; item < m; item += 1) {
      assertUniform(positions[item] as number[], trials, `positions of item ${item}`);
    }
    for (let position = 0; position < m; position += 1) {
      assertUniform(
        positions.map((row) => row[position] as number),
        trials,
        `items at position ${position}`,
      );
    }
  });
});

// Negative controls: samplers with the defects the rules forbid, fed from the
// same Web Crypto source, must fail the same tests at the same sample sizes.
describe("negative controls: the tests reject biased samplers", () => {
  const word = (from: RandomSource = source) => {
    const out = new Uint32Array(1);
    from(out);
    return out[0] as number;
  };

  test("a byte reduced with % 94 (naive modulo over a small word)", () => {
    assertBiased(
      tally(94, () => (word() >>> 24) % 94),
      SAMPLES,
      "byte % 94",
    );
  });

  test("the top 3 bits reduced with % 5 (rejection branch skipped)", () => {
    assertBiased(
      tally(5, () => (word() >>> 29) % 5),
      SAMPLES,
      "3 bits % 5",
    );
  });

  test("the top 7 bits reduced with % 94 (rejection branch skipped)", () => {
    assertBiased(
      tally(94, () => (word() >>> 25) % 94),
      SAMPLES,
      "7 bits % 94",
    );
  });

  test("a 'shuffle' that swaps every index with a random index over the whole array", () => {
    const trials = 24 * 1000;
    const counts = new Map<string, number>();
    for (let i = 0; i < trials; i += 1) {
      const out = [0, 1, 2, 3];
      for (let k = 0; k < out.length; k += 1) {
        const j = randomInt(out.length, source);
        const moved = out[k] as number;
        out[k] = out[j] as number;
        out[j] = moved;
      }
      const key = out.join("");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    assertBiased([...counts.values()], trials, "naive shuffle of 4");
  });
});
