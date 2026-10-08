// Statistical tests for src/core/password.ts with the real Web Crypto source
// (requirement S8: character distribution and class-rule correctness, R10
// and R11a: every valid password equally likely).
//
// Design
// ------
// Each assertion is a one-sided Pearson chi-square goodness-of-fit test,
// failing when the upper-tail p-value is below ALPHA = 1e-9, exactly as in
// random-stats.test.ts. For a correct generator the chance that a given
// assertion fails is therefore about 1e-9, and with 161 positive assertions in
// this file the chance of a spurious failure per CI run is roughly 1.6e-7.
// Both figures are approximate for the reasons given in random-stats.test.ts;
// the p-value itself is exact for the chi-square distribution
// (tests/unit/chi-square.ts). Every cell has at least 50 expected
// observations; where the expected distribution is not uniform, cells of
// low probability are merged with their neighbours until each bin has 50.
//
// A statistical test cannot prove uniformity; it can only fail to find a
// deviation of the size its sample can see. The exact argument is in the
// header of src/core/password.ts, and the exact count it relies on is
// checked against enumeration in password.test.ts. What these tests add is
// evidence that the implementation does what the argument says, at sample
// sizes where the known wrong ways of doing it are caught.
//
// Three groups are tested: 90 positive uniformity assertions and 71 exact-
// distribution assertions. Five negative controls must reject bias. None of
// the positive assertions can prove uniformity.
//
// 1. Character frequency per position. With the shipped configuration, every
//    class on and length 64, each of the 64 positions is tallied over the 94
//    characters, and all positions together are tallied once more. At this
//    length the at-least-one rule excludes about one string in 1,300, so the
//    accepted-character marginals are approximately uniform and
//    indistinguishable from independent uniform picks at
//    this sample size, and the test gives strong evidence that no position
//    is treated differently from any other. The look-alike exclusion (R7a)
//    is tallied over its 86-character pool.
//
// 2. Every valid password is equally likely. For tiny classes the set of all
//    strings that meet the limits is enumerated, and the generator's output
//    is tallied over that set: with the defaults (the R10 rule), with Max
//    limits, Min limits, Min = Max, Min 0, Max 0, and every type forced.
//    This is the test that gives strong evidence, at the stated false-failure
//    rate, that the count-vector draw, the shuffle and the picks together
//    make every valid password equally likely, as R11a requires and as the
//    entropy figure (item 9) will assume.
//
// 3. Realistic settings. With the shipped classes at length 20, with the
//    defaults and with Min numbers 5 and Max symbols 1, the number of
//    characters of each type is tallied against its exact expected
//    distribution (computed from `countPasswords` with that type pinned to
//    each value), the type at each of the 20 positions is tallied against
//    the exact per-position probabilities, and the characters within each
//    type are tallied for uniformity. Enumeration is impossible here (about
//    2^125 valid passwords), so these are the checks that the realistic
//    path, with its closed-form and explicit-sum table layers, agrees with
//    the exact distribution.
//
// Negative controls. Four forbidden ways of meeting the rules are run through
// the same test with the same sample sizes and must fail it: putting one
// character of each type at fixed positions; picking one character of each
// type first and shuffling it in with the rest; choosing the count vector
// uniformly among the allowed vectors instead of in proportion to the
// passwords that have it, then shuffling and filling correctly; and weighting
// the count vector by the number of arrangements alone, forgetting the sizes
// of the character sets. The last two are the near misses of the counting
// method itself: each is exactly right about positions and characters and
// wrong only about how often each count vector should appear. The shuffle-in
// method is exactly uniform when the length is one more than the number of
// types, so the controls run at length 4 with two types, where its bias is
// plain: over classes "ab" and "1" it gives 40 of the 64 valid strings
// probability 1/72 and the other 24 probability 1/54, against 1/64 for all.
//
// Source: Web Crypto throughout, fetched 1024 words at a time through
// `bufferedWebCrypto` for the reason given in random-stats.test.ts. One test
// runs on the production default to show the default is wired to Web Crypto.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import shipped from "../../src/config/config.json" with { type: "json" };
import {
  type CharacterClass,
  countPasswords,
  generatePassword,
  generatePasswords,
  type PasswordConfig,
  type PasswordCounts,
  type PasswordOptions,
  type PasswordPlan,
  type PasswordTypeName,
  planPassword,
  type TypeCount,
} from "../../src/core/password.ts";
import { pick, type RandomSource, randomBigInt, shuffle, webCrypto } from "../../src/core/random.ts";
import { chiSquarePValue, chiSquareStatistic } from "./chi-square.ts";
import { bufferedWebCrypto } from "./random-sources.ts";

/** Per-assertion false-failure probability. */
const ALPHA = 1e-9;
/** Web Crypto words, fetched in batches (see the header comment). */
const source = bufferedWebCrypto(webCrypto);
const config: PasswordConfig = shipped.password;

/** The default counts for a length, Min 1 and Max the length, with any overrides. */
function counts(length: number, overrides: Partial<Record<PasswordTypeName, Partial<TypeCount>>> = {}): PasswordCounts {
  const each = (name: PasswordTypeName): TypeCount => ({ min: 1, max: length, ...overrides[name] });
  return {
    lowercase: each("lowercase"),
    uppercase: each("uppercase"),
    numbers: each("numbers"),
    symbols: each("symbols"),
  };
}

/** Options with the given length, every class on, and the default counts for that length. */
function all(length: number, overrides: Partial<PasswordOptions> = {}): PasswordOptions {
  return {
    length,
    lowercase: true,
    uppercase: true,
    numbers: true,
    simple: true,
    complex: true,
    excludeLookAlikes: false,
    counts: counts(length),
    ...overrides,
  };
}

/** Options with the given length, every class off, and the default counts for that length. */
function none(length: number, overrides: Partial<PasswordOptions> = {}): PasswordOptions {
  return all(length, {
    lowercase: false,
    uppercase: false,
    numbers: false,
    simple: false,
    complex: false,
    ...overrides,
  });
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
    `${label}: a biased generator passed with chi-square ${stat.toFixed(1)}, p = ${p.toExponential(2)}`,
  );
}

/**
 * Asserts the counts are consistent with the given cell probabilities.
 * Adjacent cells are merged, from the first cell on, until each bin has an
 * expected count of at least 50; a short final bin joins the one before it.
 */
function assertDistribution(
  observed: readonly number[],
  probabilities: readonly number[],
  samples: number,
  label: string,
): void {
  assert.equal(observed.length, probabilities.length);
  assert.ok(Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-9, `${label}: probabilities sum to one`);
  const bins: Array<{ observed: number; expected: number }> = [];
  let current = { observed: 0, expected: 0 };
  for (let i = 0; i < observed.length; i += 1) {
    current.observed += observed[i] as number;
    current.expected += (probabilities[i] as number) * samples;
    if (current.expected >= 50) {
      bins.push(current);
      current = { observed: 0, expected: 0 };
    }
  }
  if (current.expected > 0) {
    const last = bins.pop() ?? { observed: 0, expected: 0 };
    bins.push({ observed: last.observed + current.observed, expected: last.expected + current.expected });
  }
  assert.ok(bins.length >= 2, `${label}: at least two bins`);
  const stat = chiSquareStatistic(
    bins.map((bin) => bin.observed),
    bins.map((bin) => bin.expected),
  );
  const p = chiSquarePValue(stat, bins.length - 1);
  assert.ok(p >= ALPHA, `${label}: chi-square ${stat.toFixed(1)} on ${bins.length - 1} df, p = ${p.toExponential(2)}`);
}

/** A configuration with tiny character classes; the unlisted classes keep the shipped characters. */
function tiny(characters: Partial<Record<CharacterClass, string>>): PasswordConfig {
  return {
    ...structuredClone(config),
    length: { min: 1, max: 128, default: 8 },
    characters: { ...config.characters, ...characters },
  };
}

/** Every string of the plan's length over its pool whose per-type counts are within the plan's limits. */
function validStrings(plan: PasswordPlan): string[] {
  const typeOf = new Map<string, number>();
  plan.types.forEach((type, index) => {
    for (const character of type.characters) typeOf.set(character, index);
  });
  const valid: string[] = [];
  const tally = new Array<number>(plan.types.length).fill(0);
  const walk = (prefix: string) => {
    if (prefix.length === plan.length) {
      if (plan.types.every((type, i) => (tally[i] as number) >= type.min && (tally[i] as number) <= type.max))
        valid.push(prefix);
      return;
    }
    for (const character of plan.pool) {
      const i = typeOf.get(character) as number;
      tally[i] = (tally[i] as number) + 1;
      walk(prefix + character);
      tally[i] = (tally[i] as number) - 1;
    }
  };
  walk("");
  return valid;
}

/** Tallies `trials` outputs of `generate` over the given cells; every output must be a cell. */
function tallyStrings(cells: readonly string[], trials: number, generate: () => string): number[] {
  const index = new Map(cells.map((cell, i) => [cell, i]));
  const counts = new Array<number>(cells.length).fill(0);
  for (let t = 0; t < trials; t += 1) {
    const password = generate();
    const i = index.get(password);
    assert.notEqual(i, undefined, "every output meets the limits and is drawn from the pool");
    counts[i as number] = (counts[i as number] ?? 0) + 1;
  }
  return counts;
}

/** The number of characters of each of the plan's types in a password. */
function countsIn(plan: PasswordPlan, password: string): number[] {
  const typeOf = new Map<string, number>();
  plan.types.forEach((type, index) => {
    for (const character of type.characters) typeOf.set(character, index);
  });
  const found = new Array<number>(plan.types.length).fill(0);
  for (const character of password) {
    const i = typeOf.get(character);
    assert.notEqual(i, undefined, "every character is in the pool");
    found[i as number] = (found[i as number] as number) + 1;
  }
  return found;
}

/**
 * The exact probability that the password has j characters of the plan's
 * type at `index`, for j from 0 to the length: the count with that type
 * pinned to j, over the count of the plan.
 */
function countDistribution(plan: PasswordPlan, index: number): number[] {
  const total = countPasswords(plan);
  const type = plan.types[index] as PasswordPlan["types"][number];
  const scale = 10n ** 15n;
  return Array.from({ length: plan.length + 1 }, (_, j) => {
    if (j < type.min || j > type.max) return 0;
    const pinned: PasswordPlan = {
      ...plan,
      types: plan.types.map((t, i) => (i === index ? { ...t, min: j, max: j } : t)),
    };
    return Number((countPasswords(pinned) * scale) / total) / Number(scale);
  });
}

describe("character frequency per position is consistent with uniform over the pool (chi-square, alpha 1e-9)", () => {
  test("every class on, length 64: each of the 64 positions over the 94 characters, and all positions together", () => {
    const options = all(64);
    const plan = planPassword(options, config);
    assert.equal(plan.pool.length, 94);
    const index = new Map(plan.pool.map((character, i) => [character, i]));
    const passwords = 5000;
    const perPosition = Array.from({ length: plan.length }, () => new Array<number>(94).fill(0));
    const pooled = new Array<number>(94).fill(0);
    for (let t = 0; t < passwords; t += 1) {
      const password = generatePassword(options, config, source);
      assert.equal(password.length, 64);
      for (let position = 0; position < password.length; position += 1) {
        const i = index.get(password[position] as string);
        assert.notEqual(i, undefined, "every character is in the pool");
        const row = perPosition[position] as number[];
        row[i as number] = (row[i as number] ?? 0) + 1;
        pooled[i as number] = (pooled[i as number] ?? 0) + 1;
      }
    }
    for (let position = 0; position < plan.length; position += 1) {
      assertUniform(perPosition[position] as number[], passwords, `position ${position}`);
    }
    assertUniform(pooled, passwords * plan.length, "all positions");
  });

  test("look-alikes excluded, length 64: all positions together over the 86 remaining characters", () => {
    const options = all(64, { excludeLookAlikes: true });
    const plan = planPassword(options, config);
    assert.equal(plan.pool.length, 86);
    const index = new Map(plan.pool.map((character, i) => [character, i]));
    const passwords = 2000;
    const pooled = new Array<number>(86).fill(0);
    for (let t = 0; t < passwords; t += 1) {
      for (const character of generatePassword(options, config, source)) {
        const i = index.get(character);
        assert.notEqual(i, undefined, `${character} is in the reduced pool`);
        pooled[i as number] = (pooled[i as number] ?? 0) + 1;
      }
    }
    assertUniform(pooled, passwords * plan.length, "all positions, look-alikes excluded");
  });
});

describe("every valid password is consistent with equally likely: strong evidence for R10 and R11a (alpha 1e-9)", () => {
  const cases: Array<{
    label: string;
    config: PasswordConfig;
    options: PasswordOptions;
    valid: number;
    perCell: number;
  }> = [
    {
      label: 'length 3 over lowercase "ab" and numbers "12", defaults',
      config: tiny({ lowercase: "ab", numbers: "12" }),
      options: none(3, { lowercase: true, numbers: true }),
      valid: 48, // 4^3 = 64 strings, minus 8 all-letter and 8 all-digit
      perCell: 200,
    },
    {
      label: 'length 4 over lowercase "ab" and numbers "1", defaults',
      config: tiny({ lowercase: "ab", numbers: "1" }),
      options: none(4, { lowercase: true, numbers: true }),
      valid: 64, // 3^4 = 81 strings, minus 16 all-letter and 1 all-digit
      perCell: 300,
    },
    {
      label: 'length 2 over lowercase "a", simple "!" and complex "/" (symbols are one type), defaults',
      config: tiny({ lowercase: "a", simple: "!", complex: "/" }),
      options: none(2, { lowercase: true, simple: true, complex: true }),
      valid: 4, // 3^2 = 9 strings, minus "aa" and the four all-symbol strings
      perCell: 500,
    },
    {
      label: 'length 4 over lowercase "ab" and numbers "12", Max numbers 1',
      config: tiny({ lowercase: "ab", numbers: "12" }),
      options: none(4, { lowercase: true, numbers: true, counts: counts(4, { numbers: { max: 1 } }) }),
      valid: 64, // 4 positions for the one digit, 2 digits, 2^3 letters
      perCell: 200,
    },
    {
      label: 'length 4 over lowercase "ab" and numbers "12", Min numbers 2',
      config: tiny({ lowercase: "ab", numbers: "12" }),
      options: none(4, { lowercase: true, numbers: true, counts: counts(4, { numbers: { min: 2 } }) }),
      valid: 160, // two digits: C(4,2) * 4 * 4 = 96; three digits: C(4,3) * 8 * 2 = 64
      perCell: 150,
    },
    {
      label: 'length 5 over lowercase "ab", uppercase "C" and numbers "12", uppercase exactly 1 and Max numbers 2',
      config: tiny({ lowercase: "ab", uppercase: "C", numbers: "12" }),
      options: none(5, {
        lowercase: true,
        uppercase: true,
        numbers: true,
        counts: counts(5, { uppercase: { min: 1, max: 1 }, numbers: { max: 2 } }),
      }),
      valid: 800, // 5 positions for C, then 4 positions with one digit (64) or two (96)
      perCell: 100,
    },
    {
      label: 'length 3 over lowercase "ab" and numbers "12", Min 0 for both (every string valid)',
      config: tiny({ lowercase: "ab", numbers: "12" }),
      options: none(3, {
        lowercase: true,
        numbers: true,
        counts: counts(3, { lowercase: { min: 0 }, numbers: { min: 0 } }),
      }),
      valid: 64,
      perCell: 200,
    },
    {
      label: 'length 3 over lowercase "ab" and numbers "12", numbers Min 0 and Max 0 (selected but absent)',
      config: tiny({ lowercase: "ab", numbers: "12" }),
      options: none(3, { lowercase: true, numbers: true, counts: counts(3, { numbers: { min: 0, max: 0 } }) }),
      valid: 8,
      perCell: 500,
    },
    {
      label: 'length 4 over "ab", "C", "12" and "!", every type forced to one character',
      config: tiny({ lowercase: "ab", uppercase: "C", numbers: "12", simple: "!" }),
      options: all(4, { complex: false }),
      valid: 96, // 4! arrangements, 2 letters, 2 digits
      perCell: 200,
    },
    {
      label: 'length 5 over "ab", "C", "12" and "!", Max 1 on three types (lowercase takes the rest)',
      config: tiny({ lowercase: "ab", uppercase: "C", numbers: "12", simple: "!" }),
      options: all(5, {
        complex: false,
        counts: counts(5, { uppercase: { max: 1 }, numbers: { max: 1 }, symbols: { max: 1 } }),
      }),
      valid: 480, // 5 * 4 * 3 arrangements of C, a digit and !, 2 digits, 2^2 letters
      perCell: 100,
    },
  ];

  for (const c of cases) {
    test(`${c.label}: ${c.valid} valid strings, each equally likely`, () => {
      const plan = planPassword(c.options, c.config);
      const cells = validStrings(plan);
      assert.equal(cells.length, c.valid);
      assert.equal(countPasswords(plan), BigInt(c.valid), "the count function agrees with the enumeration");
      const trials = c.valid * c.perCell;
      const counts = tallyStrings(cells, trials, () => generatePassword(c.options, c.config, source));
      assert.ok(
        counts.every((count) => count > 0),
        "every valid string appears",
      );
      assertUniform(counts, trials, c.label);
    });
  }

  test("symbols as one type: checking every outcome, a letter with either symbol class is valid and two symbols without a letter are not", () => {
    const c = cases[2] as (typeof cases)[number];
    const plan = planPassword(c.options, c.config);
    assert.deepEqual(validStrings(plan).sort(), ["!a", "/a", "a!", "a/"]);
  });

  test("length 3 over two tiny classes on the production default source", () => {
    const c = cases[0] as (typeof cases)[number];
    const cells = validStrings(planPassword(c.options, c.config));
    const trials = c.valid * 100;
    assertUniform(
      tallyStrings(cells, trials, () => generatePassword(c.options, c.config)),
      trials,
      `${c.label}, default source`,
    );
  });
});

// Negative controls: the forbidden ways of meeting the rules, fed from the
// same Web Crypto source, must fail the same test at the same sample sizes.
describe("negative controls: the tests reject forced-character and wrongly weighted generators", () => {
  const forbidden = tiny({ lowercase: "ab", numbers: "1" });
  const options = none(4, { lowercase: true, numbers: true });
  const plan = planPassword(options, forbidden);
  const cells = validStrings(plan);
  const trials = cells.length * 300;
  const letters = plan.types[0]?.characters as readonly string[];
  const digits = plan.types[1]?.characters as readonly string[];

  /** One character of each type at fixed positions, the rest from the pool. */
  function fixedPositions(from: RandomSource): string {
    const out = [pick(letters, from), pick(digits, from)];
    while (out.length < plan.length) out.push(pick(plan.pool, from));
    return out.join("");
  }

  /** One character of each type, the rest from the pool, then a Fisher-Yates shuffle. */
  function shuffledIn(from: RandomSource): string {
    const out = [pick(letters, from), pick(digits, from)];
    while (out.length < plan.length) out.push(pick(plan.pool, from));
    return shuffle(out, from).join("");
  }

  /** The allowed count vectors (letters, digits) at length 4: (3,1), (2,2) and (1,3). */
  const vectors: Array<[number, number]> = [
    [3, 1],
    [2, 2],
    [1, 3],
  ];

  /** Correct positions and characters for a chosen count vector: shuffle the labels, pick per position. */
  function fill(vector: [number, number], from: RandomSource): string {
    const labels = [...new Array<number>(vector[0]).fill(0), ...new Array<number>(vector[1]).fill(1)];
    return shuffle(labels, from)
      .map((label) => pick(label === 0 ? letters : digits, from))
      .join("");
  }

  /** The count vector chosen uniformly among the allowed vectors, then filled correctly. */
  function uniformVector(from: RandomSource): string {
    return fill(pick(vectors, from), from);
  }

  /** The count vector weighted by its arrangements alone (4, 6, 4), forgetting the set sizes, then filled correctly. */
  function arrangementsOnly(from: RandomSource): string {
    const weights = [4n, 6n, 4n];
    let target = randomBigInt(14n, from);
    for (let i = 0; i < vectors.length; i += 1) {
      if (target < (weights[i] as bigint)) return fill(vectors[i] as [number, number], from);
      target -= weights[i] as bigint;
    }
    throw new Error("unreachable");
  }

  test("forced characters at fixed positions", () => {
    assertBiased(
      tallyStrings(cells, trials, () => fixedPositions(source)),
      trials,
      "fixed positions",
    );
  });

  test("forced characters shuffled in (uniform at length 3, biased at length 4)", () => {
    assertBiased(
      tallyStrings(cells, trials, () => shuffledIn(source)),
      trials,
      "shuffled in",
    );
  });

  test("count vector chosen uniformly among the allowed vectors, then shuffled and filled correctly", () => {
    // The right weights are 32, 24 and 8 of 64; a uniform choice gives each a third.
    assertBiased(
      tallyStrings(cells, trials, () => uniformVector(source)),
      trials,
      "uniform count vector",
    );
  });

  test("count vector weighted by arrangements alone, forgetting the set sizes, then shuffled and filled correctly", () => {
    assertBiased(
      tallyStrings(cells, trials, () => arrangementsOnly(source)),
      trials,
      "arrangements-only weights",
    );
  });

  test("the real generator passes the very same test at the same sample size", () => {
    assertUniform(
      tallyStrings(cells, trials, () => generatePassword(options, forbidden, source)),
      trials,
      "the generator, same cells and trials as the controls",
    );
  });

  test("forced characters at fixed positions, length 3 over two classes of two", () => {
    const small = tiny({ lowercase: "ab", numbers: "12" });
    const smallOptions = none(3, { lowercase: true, numbers: true });
    const smallPlan = planPassword(smallOptions, small);
    const smallCells = validStrings(smallPlan);
    const smallTrials = smallCells.length * 200;
    const smallLetters = smallPlan.types[0]?.characters as readonly string[];
    const smallDigits = smallPlan.types[1]?.characters as readonly string[];
    assertBiased(
      tallyStrings(smallCells, smallTrials, () =>
        [pick(smallLetters, source), pick(smallDigits, source), pick(smallPlan.pool, source)].join(""),
      ),
      smallTrials,
      "fixed positions, length 3",
    );
  });
});

describe("realistic settings at length 20: per-type counts, per-position types and characters match the exact distribution (alpha 1e-9)", () => {
  const settings: Array<{ label: string; options: PasswordOptions; passwords: number }> = [
    { label: "the defaults (Min 1, Max 20 for every type)", options: all(20), passwords: 20_000 },
    {
      label: "Min numbers 5 and Max symbols 1",
      options: all(20, { counts: counts(20, { numbers: { min: 5 }, symbols: { max: 1 } }) }),
      passwords: 20_000,
    },
    {
      label: "Max 2 on lowercase, uppercase and numbers (symbols take at least 14), look-alikes excluded",
      options: all(20, {
        excludeLookAlikes: true,
        counts: counts(20, { lowercase: { max: 2 }, uppercase: { max: 2 }, numbers: { max: 2 } }),
      }),
      passwords: 10_000,
    },
  ];

  for (const s of settings) {
    test(s.label, () => {
      const plan = planPassword(s.options, config);
      const typeCount = plan.types.length;
      const distributions = plan.types.map((_, index) => countDistribution(plan, index));
      // The exact probability that a given position holds each type: the
      // expected count of the type over the length. The count vector is
      // drawn without regard to positions and the labels are then shuffled,
      // so every position has the same type distribution.
      const positionProbabilities = distributions.map(
        (distribution) => distribution.reduce((sum, p, j) => sum + p * j, 0) / plan.length,
      );
      assert.ok(Math.abs(positionProbabilities.reduce((a, b) => a + b, 0) - 1) < 1e-9);

      const countTallies = plan.types.map(() => new Array<number>(plan.length + 1).fill(0));
      const positionTallies = Array.from({ length: plan.length }, () => new Array<number>(typeCount).fill(0));
      const characterTallies = plan.types.map((type) => new Map(type.characters.map((c) => [c, 0])));
      for (let t = 0; t < s.passwords; t += 1) {
        const password = generatePassword(s.options, config, source);
        assert.equal(password.length, plan.length);
        const found = countsIn(plan, password);
        found.forEach((count, index) => {
          const type = plan.types[index] as PasswordPlan["types"][number];
          assert.ok(count >= type.min && count <= type.max, `${type.name} count ${count} within its limits`);
          const tally = countTallies[index] as number[];
          tally[count] = (tally[count] as number) + 1;
        });
        for (let position = 0; position < password.length; position += 1) {
          const character = password[position] as string;
          const index = plan.types.findIndex((type) => type.characters.includes(character));
          const row = positionTallies[position] as number[];
          row[index] = (row[index] as number) + 1;
          const characters = characterTallies[index] as Map<string, number>;
          characters.set(character, (characters.get(character) as number) + 1);
        }
      }

      plan.types.forEach((type, index) => {
        // A type pinned to one value (Min = Max) has a one-cell distribution;
        // the limit assertion above already checked every password for it.
        if (type.min === type.max) return;
        assertDistribution(
          countTallies[index] as number[],
          distributions[index] as number[],
          s.passwords,
          `${s.label}: count of ${type.name}`,
        );
      });
      for (let position = 0; position < plan.length; position += 1) {
        assertDistribution(
          positionTallies[position] as number[],
          positionProbabilities,
          s.passwords,
          `${s.label}: type at position ${position}`,
        );
      }
      plan.types.forEach((type, index) => {
        const tallies = [...(characterTallies[index] as Map<string, number>).values()];
        const total = tallies.reduce((a, b) => a + b, 0);
        assertUniform(tallies, total, `${s.label}: characters of ${type.name}`);
      });
    });
  }
});

describe("timing at length 128 (reported, with a generous bound)", () => {
  test("six passwords with Min numbers 5 and Max symbols 1: the arithmetic alone, and with Web Crypto per call", (t) => {
    const options = all(128, { counts: counts(128, { numbers: { min: 5 }, symbols: { max: 1 } }) });
    generatePasswords(options, config, 6, source); // warm up
    const arithmetic = performance.now();
    generatePasswords(options, config, 6, source);
    const arithmeticMs = performance.now() - arithmetic;
    const real = performance.now();
    const passwords = generatePasswords(options, config, 6);
    const realMs = performance.now() - real;
    const cold = performance.now();
    generatePasswords(
      all(128, {
        counts: counts(128, {
          lowercase: { max: 40 },
          uppercase: { max: 40 },
          numbers: { max: 40 },
          symbols: { max: 40 },
        }),
      }),
      config,
      6,
      source,
    );
    const coldMs = performance.now() - cold;
    assert.equal(passwords.length, 6);
    t.diagnostic(
      `6 x 128, tight limits: ${arithmeticMs.toFixed(1)} ms with batched words, ${realMs.toFixed(1)} ms with one Web Crypto call per draw; four bounded types of Max 40: ${coldMs.toFixed(1)} ms with batched words`,
    );
    assert.ok(arithmeticMs < 250, `arithmetic took ${arithmeticMs.toFixed(1)} ms`);
    assert.ok(realMs < 1000, `with Web Crypto per draw took ${realMs.toFixed(1)} ms`);
    assert.ok(coldMs < 500, `four bounded types took ${coldMs.toFixed(1)} ms`);
  });
});
