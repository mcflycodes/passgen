// Unit tests for src/core/password.ts: the options rules (R8), the plan each
// request resolves to (R7, R7a, R10 types, R11a limits), the R11b adjustment,
// every error path (R6, R9, R11, R11a, R11b), the exact count of valid
// passwords against enumeration, deterministic sources showing how the
// count vector, the positions and the characters are drawn, fail-closed
// behaviour with a one-character class, and a check that no error carries a
// generated value (S6). Distribution tests with the real source are in
// password-stats.test.ts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import shipped from "../../src/config/config.json" with { type: "json" };
import {
  applySymbolRule,
  type CharacterClass,
  CountRangeError,
  countPasswords,
  defaultCounts,
  defaultOptions,
  generatePassword,
  generatePasswords,
  LengthBelowTypesError,
  LengthOutOfRangeError,
  MinAboveMaxError,
  NoTypesSelectedError,
  normalizeCounts,
  PASSWORD_TYPE_NAMES,
  type PasswordConfig,
  type PasswordCounts,
  PasswordError,
  type PasswordOptions,
  type PasswordPlan,
  type PasswordTypeName,
  planPassword,
  SymbolRuleError,
  symbolRuleHolds,
  type TypeCount,
} from "../../src/core/password.ts";
import { RandomUnavailableError, webCrypto, webCryptoFrom } from "../../src/core/random.ts";
import { counting, neverSource, topBits, wordsSource } from "./random-sources.ts";

const config: PasswordConfig = shipped.password;
const LOOK_ALIKES = [..."lIO01|`'"];

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

const ALL = all(20);
const NONE = none(20);

/**
 * A configuration with tiny character classes, so that a test can name the
 * exact words that produce each password. Classes not listed keep the shipped
 * characters; unlisted options keep the shipped values unless overridden.
 */
function tiny(
  characters: Partial<Record<CharacterClass, string>>,
  overrides: Partial<Omit<PasswordConfig, "characters">> = {},
): PasswordConfig {
  return {
    ...structuredClone(config),
    length: { min: 1, max: 128, default: 8 },
    ...overrides,
    characters: { ...config.characters, ...characters },
  };
}

/** The set of type names a password contains, for the shipped classes. */
function typesIn(password: string): Set<string> {
  return new Set(Object.entries(countsIn(password)).flatMap(([name, count]) => (count > 0 ? [name] : [])));
}

/** The number of characters of each type in a password, for the shipped classes. */
function countsIn(password: string): Record<PasswordTypeName, number> {
  const found = { lowercase: 0, uppercase: 0, numbers: 0, symbols: 0 };
  for (const character of password) {
    if (config.characters.lowercase.includes(character)) found.lowercase += 1;
    else if (config.characters.uppercase.includes(character)) found.uppercase += 1;
    else if (config.characters.numbers.includes(character)) found.numbers += 1;
    else if (config.characters.simple.includes(character) || config.characters.complex.includes(character))
      found.symbols += 1;
    else assert.fail(`unknown character ${character}`);
  }
  return found;
}

/** Every string of the plan's length over its pool whose per-type counts are within the plan's limits. */
function enumerate(plan: PasswordPlan): string[] {
  const typeOf = new Map<string, number>();
  plan.types.forEach((type, index) => {
    for (const character of type.characters) typeOf.set(character, index);
  });
  const valid: string[] = [];
  const tally = new Array<number>(plan.types.length).fill(0);
  const walk = (prefix: string) => {
    if (prefix.length === plan.length) {
      if (
        plan.types.every((type, index) => (tally[index] as number) >= type.min && (tally[index] as number) <= type.max)
      )
        valid.push(prefix);
      return;
    }
    for (const character of plan.pool) {
      const index = typeOf.get(character) as number;
      tally[index] = (tally[index] as number) + 1;
      walk(prefix + character);
      tally[index] = (tally[index] as number) - 1;
    }
  };
  walk("");
  return valid;
}

describe("defaultOptions: the page starts from the configured defaults (R5, R6, R7, R7a, R11a)", () => {
  test("mirrors the shipped configuration, with Min 1 and Max equal to the default length for every type", () => {
    assert.deepEqual(defaultOptions(config), {
      length: 20,
      lowercase: true,
      uppercase: true,
      numbers: true,
      simple: true,
      complex: true,
      excludeLookAlikes: false,
      counts: {
        lowercase: { min: 1, max: 20 },
        uppercase: { min: 1, max: 20 },
        numbers: { min: 1, max: 20 },
        symbols: { min: 1, max: 20 },
      },
    });
  });

  test("follows a configuration with other defaults", () => {
    const other = tiny({}, { excludeLookAlikes: true, enabled: { ...config.enabled, complex: false } });
    const options = defaultOptions(other);
    assert.equal(options.length, 8);
    assert.equal(options.complex, false);
    assert.equal(options.excludeLookAlikes, true);
    assert.deepEqual(options.counts.symbols, { min: 1, max: 8 });
  });

  test("defaultCounts resolves a null Max to the length and clamps a numeric Max to it", () => {
    const limited = tiny(
      {},
      {
        counts: {
          lowercase: { min: 0, max: 50 },
          uppercase: { min: 2, max: 3 },
          numbers: { min: 1, max: null },
          symbols: { min: 1, max: null },
        },
      },
    );
    assert.deepEqual(defaultCounts(limited, 10), {
      lowercase: { min: 0, max: 10 },
      uppercase: { min: 2, max: 3 },
      numbers: { min: 1, max: 10 },
      symbols: { min: 1, max: 10 },
    });
    assert.deepEqual(defaultOptions(limited).counts.lowercase, { min: 0, max: 8 });
    assert.deepEqual(PASSWORD_TYPE_NAMES, ["lowercase", "uppercase", "numbers", "symbols"]);
  });
});

describe("applySymbolRule: Complex implies Simple (R8)", () => {
  test("checking Complex while Simple is off turns Simple on too", () => {
    const before = { ...ALL, simple: false, complex: true };
    assert.deepEqual(applySymbolRule(before, "complex"), { ...ALL, simple: true, complex: true });
  });

  test("unchecking Simple while Complex is on turns Complex off too", () => {
    const before = { ...ALL, simple: false, complex: true };
    assert.deepEqual(applySymbolRule(before, "simple"), { ...ALL, simple: false, complex: false });
  });

  test("unchecking Complex leaves Simple as it is", () => {
    assert.deepEqual(applySymbolRule({ ...ALL, complex: false }, "complex"), { ...ALL, complex: false });
    const simpleOff = { ...ALL, simple: false, complex: false };
    assert.deepEqual(applySymbolRule(simpleOff, "complex"), simpleOff);
  });

  test("checking Simple changes nothing else, and both can be off", () => {
    assert.deepEqual(applySymbolRule({ ...ALL, simple: true, complex: false }, "simple"), {
      ...ALL,
      simple: true,
      complex: false,
    });
    const bothOff = { ...ALL, simple: false, complex: false };
    assert.deepEqual(applySymbolRule(bothOff, "simple"), bothOff);
    assert.ok(symbolRuleHolds(bothOff));
  });

  test("checking Complex while Simple is on is a no-op", () => {
    assert.deepEqual(applySymbolRule(ALL, "complex"), ALL);
  });

  test("is pure: the input is not changed and the result is a new object", () => {
    const before = Object.freeze({ ...ALL, simple: false, complex: true });
    const after = applySymbolRule(before, "complex");
    assert.notEqual(after, before);
    assert.equal(before.simple, false);
    assert.notEqual(applySymbolRule(ALL, "simple"), ALL);
  });

  test("symbolRuleHolds is false only for Complex on with Simple off", () => {
    assert.equal(symbolRuleHolds({ ...ALL, simple: false, complex: true }), false);
    assert.ok(symbolRuleHolds(ALL));
    assert.ok(symbolRuleHolds({ ...ALL, complex: false }));
    assert.ok(symbolRuleHolds({ ...ALL, simple: false, complex: false }));
  });
});

describe("planPassword: the pool and the types of a request (R7, R7a, R10, R11a)", () => {
  test("every class on gives the 94 characters of R7 in configuration order, in four types with their limits", () => {
    const plan = planPassword(ALL, config);
    assert.equal(plan.length, 20);
    assert.equal(plan.pool.join(""), Object.values(config.characters).join(""));
    assert.equal(plan.pool.length, 94);
    assert.equal(new Set(plan.pool).size, 94);
    assert.deepEqual(
      plan.types.map((type) => [type.name, type.characters.length, type.min, type.max]),
      [
        ["lowercase", 26, 1, 20],
        ["uppercase", 26, 1, 20],
        ["numbers", 10, 1, 20],
        ["symbols", 32, 1, 20],
      ],
    );
  });

  test("Simple and Complex symbols are one type, in the order simple then complex", () => {
    const symbols = planPassword(ALL, config).types.find((type) => type.name === "symbols");
    assert.ok(symbols);
    assert.equal(symbols.characters.join(""), config.characters.simple + config.characters.complex);
    // The split between Simple and Complex is a configuration choice (R7), so
    // the Simple-only sizes are read from the configuration rather than fixed.
    const simpleSize = config.characters.simple.length;
    const simpleOnly = planPassword({ ...ALL, complex: false }, config);
    assert.deepEqual(
      simpleOnly.types.map((type) => [type.name, type.characters.length]),
      [
        ["lowercase", 26],
        ["uppercase", 26],
        ["numbers", 10],
        ["symbols", simpleSize],
      ],
    );
    assert.equal(simpleOnly.pool.length, 62 + simpleSize);
    assert.equal(
      simpleOnly.pool.join(""),
      config.characters.lowercase + config.characters.uppercase + config.characters.numbers + config.characters.simple,
    );
  });

  test("a class that is off is absent from the pool and the types", () => {
    const plan = planPassword({ ...ALL, uppercase: false, simple: false, complex: false }, config);
    assert.equal(plan.pool.join(""), config.characters.lowercase + config.characters.numbers);
    assert.deepEqual(
      plan.types.map((type) => type.name),
      ["lowercase", "numbers"],
    );
    const one = planPassword({ ...NONE, numbers: true }, config);
    assert.deepEqual(one.pool, [..."0123456789"]);
    assert.equal(one.types.length, 1);
  });

  test("the look-alike option removes exactly the eight R7a characters from every class", () => {
    const plan = planPassword({ ...ALL, excludeLookAlikes: true }, config);
    assert.equal(plan.pool.length, 86);
    for (const character of LOOK_ALIKES) assert.ok(!plan.pool.includes(character), `${character} excluded`);
    const kept = Object.values(config.characters)
      .join("")
      .split("")
      .filter((character) => !LOOK_ALIKES.includes(character));
    assert.deepEqual(plan.pool, kept);
    assert.deepEqual(
      plan.types.map((type) => [type.name, type.characters.length]),
      [
        ["lowercase", 25],
        ["uppercase", 24],
        ["numbers", 8],
        ["symbols", 29],
      ],
    );
    assert.ok(plan.pool.includes("o"), "lowercase o stays");
  });

  test("the look-alike option off keeps all 94, whatever the look-alike set says", () => {
    assert.equal(planPassword({ ...ALL, excludeLookAlikes: false }, config).pool.length, 94);
  });

  test("only an option that is exactly true selects a class (R26: corrupt settings can only turn a class off)", () => {
    const corrupt = { ...NONE, lowercase: "true", numbers: 1 } as unknown as PasswordOptions;
    assert.throws(() => planPassword(corrupt, config), NoTypesSelectedError);
    const lookAlikes = { ...ALL, excludeLookAlikes: "true" } as unknown as PasswordOptions;
    assert.equal(planPassword(lookAlikes, config).pool.length, 94);
  });

  test("the plan carries the requested Min and Max of each selected type, and ignores the counts of unselected types", () => {
    const options = all(20, {
      uppercase: false,
      counts: counts(20, { lowercase: { min: 2, max: 10 }, uppercase: { min: 99, max: -5 }, symbols: { max: 1 } }),
    });
    const plan = planPassword(options, config);
    assert.deepEqual(
      plan.types.map((type) => [type.name, type.min, type.max]),
      [
        ["lowercase", 2, 10],
        ["numbers", 1, 20],
        ["symbols", 1, 1],
      ],
    );
  });

  test("Min 0 and Max 0 are allowed: a type may be selected and absent", () => {
    const plan = planPassword(
      all(20, { counts: counts(20, { numbers: { min: 0 }, symbols: { min: 0, max: 0 } }) }),
      config,
    );
    assert.deepEqual(
      plan.types.map((type) => [type.name, type.min, type.max]),
      [
        ["lowercase", 1, 20],
        ["uppercase", 1, 20],
        ["numbers", 0, 20],
        ["symbols", 0, 0],
      ],
    );
  });

  test("draws no randomness", () => {
    planPassword(ALL, config);
  });
});

describe("R11b: the Max counts are raised to cover the length (planPassword and normalizeCounts)", () => {
  test("Max counts that add up to less than the length raise lowercase Max by the shortfall", () => {
    const options = all(20, {
      counts: counts(20, { lowercase: { max: 3 }, uppercase: { max: 3 }, numbers: { max: 3 }, symbols: { max: 3 } }),
    });
    const plan = planPassword(options, config);
    assert.deepEqual(
      plan.types.map((type) => [type.name, type.max]),
      [
        ["lowercase", 11],
        ["uppercase", 3],
        ["numbers", 3],
        ["symbols", 3],
      ],
    );
    assert.deepEqual(normalizeCounts(options, config), {
      lowercase: { min: 1, max: 11 },
      uppercase: { min: 1, max: 3 },
      numbers: { min: 1, max: 3 },
      symbols: { min: 1, max: 3 },
    });
  });

  test("with lowercase off, the first selected type in the order uppercase, numbers, symbols is raised", () => {
    const limited = counts(20, {
      lowercase: { max: 1 },
      uppercase: { max: 2 },
      numbers: { max: 2 },
      symbols: { max: 2 },
    });
    const noLower = normalizeCounts(all(20, { lowercase: false, counts: limited }), config);
    assert.deepEqual(noLower.uppercase, { min: 1, max: 16 });
    assert.deepEqual(noLower.lowercase, { min: 1, max: 1 }, "an unselected type is returned as it was");
    const noLetters = normalizeCounts(all(20, { lowercase: false, uppercase: false, counts: limited }), config);
    assert.deepEqual(noLetters.numbers, { min: 1, max: 18 });
    assert.deepEqual(noLetters.uppercase, { min: 1, max: 2 });
    const symbolsOnly = normalizeCounts(none(20, { simple: true, counts: limited }), config);
    assert.deepEqual(symbolsOnly.symbols, { min: 1, max: 20 });
  });

  test("Max counts that already cover the length are returned unchanged, including the defaults", () => {
    assert.deepEqual(normalizeCounts(ALL, config), ALL.counts);
    const exact = counts(20, {
      lowercase: { max: 5 },
      uppercase: { max: 5 },
      numbers: { max: 5 },
      symbols: { max: 5 },
    });
    assert.deepEqual(normalizeCounts(all(20, { counts: exact }), config), exact);
    const over = counts(20, { lowercase: { max: 5 }, uppercase: { max: 6 }, numbers: { max: 5 }, symbols: { max: 5 } });
    assert.deepEqual(normalizeCounts(all(20, { counts: over }), config), over);
  });

  test("a Max of 0 on the raised type is raised like any other", () => {
    const zero = counts(4, {
      lowercase: { min: 0, max: 0 },
      uppercase: { max: 1 },
      numbers: { max: 1 },
      symbols: { max: 1 },
    });
    assert.deepEqual(normalizeCounts(all(4, { counts: zero }), config).lowercase, { min: 0, max: 1 });
  });

  test("is pure: the options are not changed, the result is a new object, and nothing is drawn", () => {
    const options = Object.freeze(
      all(20, {
        counts: Object.freeze(
          counts(20, { lowercase: { max: 1 }, uppercase: { max: 1 }, numbers: { max: 1 }, symbols: { max: 1 } }),
        ),
      }),
    );
    const before = structuredClone(options);
    const adjusted = normalizeCounts(options, config);
    assert.deepEqual(options, before);
    assert.notEqual(adjusted, options.counts);
    assert.equal(adjusted.lowercase.max, 17);
  });
});

describe("planPassword and generatePassword refuse a bad request before drawing any randomness", () => {
  test("R9: no character type selected", () => {
    assert.throws(() => planPassword(NONE, config), NoTypesSelectedError);
    assert.throws(() => generatePassword(NONE, config, neverSource), NoTypesSelectedError);
    assert.throws(() => generatePasswords(NONE, config, 5, neverSource), NoTypesSelectedError);
  });

  test("R11: length below the number of selected types, with Simple and Complex as one type", () => {
    const small = tiny({});
    const four = all(3);
    assert.throws(
      () => generatePassword(four, small, neverSource),
      (error: unknown) =>
        error instanceof LengthBelowTypesError &&
        error.length === 3 &&
        error.types === 4 &&
        error.minimums === 4 &&
        error.name === "LengthBelowTypesError",
    );
    // Four classes but three types: symbols count once, so length 3 is fine and length 2 is not.
    const threeTypes = all(3, { uppercase: false });
    assert.equal(planPassword(threeTypes, small).types.length, 3);
    assert.throws(
      () => generatePassword(all(2, { uppercase: false }), small, neverSource),
      (error: unknown) => error instanceof LengthBelowTypesError && error.types === 3 && error.minimums === 3,
    );
    assert.throws(() => generatePassword(none(0, { numbers: true }), small, neverSource), LengthOutOfRangeError);
    assert.doesNotThrow(() => planPassword(none(1, { numbers: true }), small));
  });

  test("R11b: Min counts that add up to more than the length, with Min 0 types not counting", () => {
    const small = tiny({});
    assert.throws(
      () =>
        generatePassword(
          all(8, { counts: counts(8, { lowercase: { min: 4 }, numbers: { min: 3 } }) }),
          small,
          neverSource,
        ),
      (error: unknown) =>
        error instanceof LengthBelowTypesError && error.length === 8 && error.types === 4 && error.minimums === 9,
    );
    assert.doesNotThrow(() =>
      planPassword(all(8, { counts: counts(8, { lowercase: { min: 4 }, numbers: { min: 2 } }) }), small),
    );
    // With every Min at 0, two characters can hold four selected types.
    const zeros = counts(2, { lowercase: { min: 0 }, uppercase: { min: 0 }, numbers: { min: 0 }, symbols: { min: 0 } });
    assert.doesNotThrow(() => planPassword(all(2, { counts: zeros }), small));
    assert.equal(generatePassword(all(2, { counts: zeros }), small).length, 2);
  });

  test("R11 cannot arise with the shipped configuration: the minimum length covers every type", () => {
    assert.ok(config.length.min >= planPassword(ALL, config).types.length);
    assert.throws(() => generatePassword(all(3), config, neverSource), LengthOutOfRangeError);
  });

  test("R6: length outside the configured bounds or not an integer", () => {
    const bad = [
      3,
      129,
      0,
      -20,
      4.5,
      20.000001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "20",
      null,
      undefined,
      true,
      [20],
    ];
    for (const length of bad) {
      const options = { ...ALL, length } as unknown as PasswordOptions;
      assert.throws(
        () => generatePassword(options, config, neverSource),
        (error: unknown) =>
          error instanceof LengthOutOfRangeError &&
          error.min === 4 &&
          error.max === 128 &&
          error.name === "LengthOutOfRangeError",
        `length ${String(length)}`,
      );
    }
    for (const length of [4, 5, 20, 127, 128]) assert.equal(planPassword(all(length), config).length, length);
  });

  test("R8: Complex symbols on with Simple symbols off", () => {
    const options = { ...ALL, simple: false, complex: true };
    assert.throws(() => planPassword(options, config), SymbolRuleError);
    assert.throws(() => generatePassword(options, config, neverSource), SymbolRuleError);
  });

  test("R11a: a Min that is not an integer from 0 to the length", () => {
    for (const min of [-1, 21, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined, true]) {
      const options = { ...ALL, counts: { ...ALL.counts, numbers: { min, max: 20 } } } as unknown as PasswordOptions;
      assert.throws(
        () => generatePassword(options, config, neverSource),
        (error: unknown) =>
          error instanceof CountRangeError &&
          error.type === "numbers" &&
          error.field === "min" &&
          error.min === 0 &&
          error.max === 20 &&
          error.name === "CountRangeError",
        `min ${String(min)}`,
      );
    }
  });

  test("R11a: a Max that is not an integer from 0 to the length", () => {
    for (const max of [-1, 21, 128, 1.5, Number.NaN, "20", null, undefined]) {
      const options = { ...ALL, counts: { ...ALL.counts, symbols: { min: 1, max } } } as unknown as PasswordOptions;
      assert.throws(
        () => generatePassword(options, config, neverSource),
        (error: unknown) =>
          error instanceof CountRangeError && error.type === "symbols" && error.field === "max" && error.max === 20,
        `max ${String(max)}`,
      );
    }
    // A Max equal to the length is the largest allowed, at every length.
    assert.doesNotThrow(() => planPassword(all(128), config));
    assert.doesNotThrow(() => planPassword(all(4), config));
  });

  test("R11b: a Min above its Max", () => {
    const options = all(20, { counts: counts(20, { uppercase: { min: 5, max: 4 } }) });
    assert.throws(
      () => generatePassword(options, config, neverSource),
      (error: unknown) =>
        error instanceof MinAboveMaxError &&
        error.type === "uppercase" &&
        error.min === 5 &&
        error.max === 4 &&
        error.name === "MinAboveMaxError",
    );
    assert.doesNotThrow(() => planPassword(all(20, { counts: counts(20, { uppercase: { min: 4, max: 4 } }) }), config));
  });

  test("counts missing altogether, or not an object, is a CountRangeError for the first selected type", () => {
    for (const bad of [undefined, null, "counts", 7, []]) {
      const options = { ...ALL, counts: bad } as unknown as PasswordOptions;
      assert.throws(
        () => generatePassword(options, config, neverSource),
        (error: unknown) => error instanceof CountRangeError && error.type === "lowercase" && error.field === "min",
        `counts ${String(bad)}`,
      );
    }
    const partial = { ...ALL, counts: { lowercase: { min: 1, max: 20 } } } as unknown as PasswordOptions;
    assert.throws(
      () => planPassword(partial, config),
      (error: unknown) => error instanceof CountRangeError && error.type === "uppercase",
    );
  });

  test("the counts of an unselected type are never checked", () => {
    const garbage = {
      ...ALL,
      uppercase: false,
      counts: { ...ALL.counts, uppercase: "no" },
    } as unknown as PasswordOptions;
    assert.doesNotThrow(() => planPassword(garbage, config));
  });

  test("checks run in the documented order: length, symbol rule, no types, counts per type in order, sum of Mins", () => {
    assert.throws(() => planPassword({ ...NONE, length: 200 }, config), LengthOutOfRangeError);
    assert.throws(() => planPassword({ ...NONE, simple: false, complex: true }, config), SymbolRuleError);
    assert.throws(() => planPassword(none(1), tiny({})), NoTypesSelectedError);
    const broken = {
      ...all(3),
      counts: {
        lowercase: { min: 1, max: 3 },
        uppercase: { min: 2, max: 1 },
        numbers: { min: -1, max: 1 },
        symbols: { min: 1, max: 9 },
      },
    };
    assert.throws(
      () => planPassword(broken, tiny({})),
      (error: unknown) => error instanceof MinAboveMaxError && error.type === "uppercase",
    );
    const next = { ...broken, counts: { ...broken.counts, uppercase: { min: 1, max: 1 } } };
    assert.throws(
      () => planPassword(next, tiny({})),
      (error: unknown) => error instanceof CountRangeError && error.type === "numbers" && error.field === "min",
    );
    const last = { ...next, counts: { ...next.counts, numbers: { min: 1, max: 1 } } };
    assert.throws(
      () => planPassword(last, tiny({})),
      (error: unknown) => error instanceof CountRangeError && error.type === "symbols" && error.field === "max",
    );
    assert.throws(() => planPassword(all(1), tiny({})), LengthBelowTypesError);
  });

  test("a configuration that empties a selected class fails closed (the validator refuses it first)", () => {
    const empty = tiny({ numbers: "" });
    assert.throws(() => generatePassword(none(4, { numbers: true }), empty, neverSource), PasswordError);
    const noSymbols = tiny({ simple: "" });
    assert.throws(() => generatePassword(none(4, { simple: true }), noSymbols, neverSource), PasswordError);
    const allExcluded = tiny({ numbers: "01" }, { lookAlikes: "01" });
    assert.throws(
      () => generatePassword(none(4, { numbers: true, excludeLookAlikes: true }), allExcluded, neverSource),
      PasswordError,
    );
  });

  test("a configuration with overlapping classes fails closed (the validator refuses it first)", () => {
    const overlap = tiny({ lowercase: "ab", uppercase: "aB" });
    assert.throws(() => generatePassword(all(4), overlap, neverSource), PasswordError);
  });

  test("every error is a PasswordError and an Error, named after its class", () => {
    const errors = [
      new NoTypesSelectedError("x"),
      new LengthBelowTypesError(3, 4, 4),
      new LengthOutOfRangeError(4, 128),
      new SymbolRuleError("x"),
      new CountRangeError("numbers", "max", 0, 20),
      new MinAboveMaxError("symbols", 3, 2),
    ];
    for (const error of errors) {
      assert.ok(error instanceof PasswordError);
      assert.ok(error instanceof Error);
      assert.equal(error.name, error.constructor.name);
    }
    assert.match(new LengthBelowTypesError(8, 4, 9).message, /length 8 .* 9 characters .* 4 character types/);
    assert.match(new CountRangeError("numbers", "max", 0, 20).message, /Max count for numbers .* 0 to 20/);
    assert.match(new MinAboveMaxError("symbols", 3, 2).message, /Min count for symbols \(3\) .* Max count \(2\)/);
  });

  test("S6: no error from any path carries a generated password or a run of configured characters", () => {
    // Real passwords from Web Crypto, including the shortest length, where
    // a leak would be easiest to miss by eye.
    const passwords = [4, 4, 4, 5, 8, 20, 64].map((length) => generatePassword(all(length), config));
    // Every run of four consecutive characters from each configured class and
    // from the look-alike set: a message that echoed a class would contain one.
    const runs = new Set<string>();
    for (const characters of [...Object.values(config.characters), config.lookAlikes]) {
      for (let i = 0; i + 4 <= characters.length; i += 1) runs.add(characters.slice(i, i + 4));
    }
    assert.ok(runs.size > 20);

    // Provoke every error path through the real code, with the real
    // configuration where the path allows it.
    const errors: Array<[string, unknown]> = [];
    const provoke = (label: string, run: () => unknown) => {
      try {
        run();
      } catch (error) {
        errors.push([label, error]);
        return;
      }
      assert.fail(`${label}: expected a throw`);
    };
    provoke("R9 no types", () => generatePassword(NONE, config));
    provoke("R11 length below types", () => generatePassword(all(3), tiny({})));
    provoke("R11b minimums above length", () =>
      generatePassword(all(20, { counts: counts(20, { numbers: { min: 18 } }) }), config),
    );
    provoke("R6 length too long", () => generatePassword(all(129), config));
    provoke("R6 length not a number", () =>
      generatePassword({ ...ALL, length: passwords[0] } as unknown as PasswordOptions, config),
    );
    provoke("R8 symbol rule", () => generatePassword({ ...ALL, simple: false, complex: true }, config));
    provoke("R11a min out of range", () =>
      generatePassword(all(20, { counts: counts(20, { numbers: { min: -1 } }) }), config),
    );
    provoke("R11a max out of range", () =>
      generatePassword(all(20, { counts: counts(20, { numbers: { max: 21 } }) }), config),
    );
    provoke("R11a min not a number", () =>
      generatePassword(
        { ...ALL, counts: { ...ALL.counts, numbers: { min: passwords[2], max: 20 } } } as unknown as PasswordOptions,
        config,
      ),
    );
    provoke("R11b min above max", () =>
      generatePassword(all(20, { counts: counts(20, { symbols: { min: 3, max: 2 } }) }), config),
    );
    provoke("empty class", () => generatePassword(none(4, { numbers: true }), tiny({ numbers: "" })));
    provoke("overlapping classes", () => generatePassword(all(4), tiny({ lowercase: "ab", uppercase: "aB" })));
    provoke("bad count", () => generatePasswords(ALL, config, -1));
    provoke("S1 crypto missing", () => generatePassword(ALL, config, webCryptoFrom(undefined)));
    const foreignCause = new Error(`quota ${passwords[1]}`);
    provoke("S1 crypto throws", () =>
      generatePassword(
        ALL,
        config,
        webCryptoFrom({
          getRandomValues() {
            throw foreignCause;
          },
        }),
      ),
    );
    assert.equal(errors.length, 15, "every error path was provoked");

    /** Inspect wrapper properties except stack paths; String(error) already covers name and message. */
    const texts = (value: unknown, seen = new Set<object>()): string[] => {
      // Only the exact foreign object is exempt; copied text is never exempt.
      if (value === foreignCause) return [];
      if (value === null || typeof value !== "object") return [String(value)];
      if (seen.has(value)) return [];
      seen.add(value);
      return [
        String(value),
        ...Reflect.ownKeys(value)
          .filter((key) => key !== "stack")
          .flatMap((key) => [String(key), ...texts(Reflect.get(value, key), seen)]),
      ];
    };
    const leaks = (text: string) => [
      ...passwords.filter((password) => text.includes(password)).map((p) => `password of length ${p.length}`),
      ...[...runs].filter((run) => text.includes(run)).map(() => "a configured character run"),
    ];
    for (const [label, error] of errors) {
      for (const text of texts(error)) {
        assert.deepEqual(leaks(text), [], `${label} leaks in: ${text.replace(/[!-~]/g, "*")}`);
      }
    }

    // The check has teeth: a message that does carry a password or a class run is caught.
    assert.deepEqual(leaks(`rejected ${passwords[0]}`), ["password of length 4"]);
    assert.equal(leaks(`pool ${config.characters.lowercase}`).length, 23);
    assert.deepEqual(leaks(new LengthOutOfRangeError(4, 128).message), []);
  });

  // Whole-password rejection and its exhaustion error were removed in #23.
  // Random draws may still be rejected; source failure can interrupt a
  // partially filled password or a batch after earlier results were made.
  for (const stage of ["rejected draw", "partial candidate", "earlier batch result"] as const) {
    test(`S6: source failure never exposes ${stage}`, () => {
      const small = tiny({ numbers: "789" });
      const options = none(4, { numbers: true });
      const complete = [0, 0, 0, 0, topBits(0, 2), topBits(1, 2), topBits(2, 2), topBits(0, 2)];
      assert.equal(generatePassword(options, small, wordsSource(complete)), "7897");
      const rejectedWord = topBits(127, 7);
      const words =
        stage === "rejected draw" ? [rejectedWord] : stage === "partial candidate" ? complete.slice(0, -1) : complete;
      const deterministic = wordsSource(words);
      const cause = new Error("source unavailable");
      const source = webCryptoFrom({
        getRandomValues(out: Uint32Array) {
          try {
            deterministic(out);
          } catch {
            throw cause;
          }
          return out;
        },
      });
      assert.throws(
        () => generatePasswords(options, small, stage === "earlier batch result" ? 2 : 1, source),
        (error: unknown) => {
          assert.ok(error instanceof RandomUnavailableError);
          assert.equal(error.cause, cause);
          const inspect = (value: unknown, seen = new Set<object>()): void => {
            if (value === cause) return;
            if (value !== null && typeof value === "object") {
              if (seen.has(value)) return;
              seen.add(value);
              // Stack locations describe the checkout, not generated output.
              for (const key of Reflect.ownKeys(value)) {
                if (key !== "stack") inspect(Reflect.get(value, key), seen);
              }
            }
            const texts = [String(value)];
            if (Array.isArray(value) && value.every((element) => typeof element === "string"))
              texts.push(value.join(""));
            for (const text of texts) {
              assert.doesNotMatch(text, /127|789/, "no rejected draw, partial candidate or earlier result");
              assert.ok(!text.includes(String(rejectedWord)), "no raw rejected word");
            }
          };
          inspect(error);
          return true;
        },
      );
      assert.equal(deterministic.consumed, words.length, "failure follows the intended deterministic draws");
    });
  }
});

describe("countPasswords: the exact number of valid passwords (R11a, for the entropy of item 9)", () => {
  test("with the defaults it is the R10 count: all strings minus those missing a type, by inclusion-exclusion", () => {
    // Four types of sizes a, b, c, d over a pool of n = a + b + c + d: the
    // strings missing at least one type are subtracted and added back by the
    // size of the subset that is missing.
    const sizes = [26n, 26n, 10n, 32n];
    const exact = (length: bigint) => {
      let total = 0n;
      for (let subset = 0; subset < 16; subset += 1) {
        let present = 0n;
        let sign = 1n;
        sizes.forEach((size, i) => {
          if (subset & (1 << i)) sign = -sign;
          else present += size;
        });
        total += sign * present ** length;
      }
      return total;
    };
    for (const length of [4, 5, 20, 64, 128]) {
      assert.equal(countPasswords(planPassword(all(length), config)), exact(BigInt(length)), `length ${length}`);
    }
    assert.equal(
      countPasswords(planPassword(all(4), config)),
      24n * 26n * 26n * 10n * 32n,
      "length 4: one of each, in any order",
    );
  });

  test("matches enumeration for small alphabets and every kind of limit", () => {
    const abc = tiny({ lowercase: "ab", uppercase: "C", numbers: "12", simple: "!", complex: "/" });
    const cases: Array<[string, PasswordOptions]> = [
      ["defaults, length 3, two types", none(3, { lowercase: true, numbers: true })],
      ["defaults, length 4, four types (one of each)", all(4)],
      ["defaults, length 5, four types", all(5)],
      ["symbols as one type (Simple and Complex), length 3", none(3, { lowercase: true, simple: true, complex: true })],
      [
        "Min 0 for every type, length 3",
        all(3, {
          counts: counts(3, { lowercase: { min: 0 }, uppercase: { min: 0 }, numbers: { min: 0 }, symbols: { min: 0 } }),
        }),
      ],
      ["Max 1 for symbols, length 5", all(5, { counts: counts(5, { symbols: { max: 1 } }) })],
      ["Min = Max for numbers (exactly 2), length 5", all(5, { counts: counts(5, { numbers: { min: 2, max: 2 } }) })],
      [
        "Min 2 for lowercase, Max 1 for uppercase, length 5",
        all(5, { counts: counts(5, { lowercase: { min: 2 }, uppercase: { max: 1 } }) }),
      ],
      [
        "Max 0 for numbers (selected but absent), length 4",
        all(4, { counts: counts(4, { numbers: { min: 0, max: 0 } }) }),
      ],
      ["a single-character type with Min 2, length 5", all(5, { counts: counts(5, { uppercase: { min: 2 } }) })],
      ["every type forced: Mins add up to the length", all(5, { counts: counts(5, { lowercase: { min: 2 } }) })],
      [
        "one type only, Min = Max = length",
        none(4, { lowercase: true, counts: counts(4, { lowercase: { min: 4, max: 4 } }) }),
      ],
      ["one single-character type, length 3", none(3, { uppercase: true })],
      [
        "Max counts below the length, raised on lowercase (R11b)",
        all(6, {
          counts: counts(6, { lowercase: { max: 1 }, uppercase: { max: 1 }, numbers: { max: 1 }, symbols: { max: 1 } }),
        }),
      ],
      [
        "three types bounded, length 6",
        none(6, {
          lowercase: true,
          numbers: true,
          simple: true,
          counts: counts(6, {
            lowercase: { min: 2, max: 3 },
            numbers: { min: 1, max: 2 },
            symbols: { min: 1, max: 2 },
          }),
        }),
      ],
    ];
    for (const [label, options] of cases) {
      const plan = planPassword(options, abc);
      const valid = enumerate(plan);
      assert.equal(countPasswords(plan), BigInt(valid.length), label);
      assert.equal(new Set(valid).size, valid.length, `${label}: enumeration has no duplicates`);
      assert.ok(valid.length > 0, `${label}: some password is valid`);
    }
  });

  test("count edge cases: length at the configured minimum and maximum, and a Min = Max type", () => {
    const min = countPasswords(planPassword(all(config.length.min), config));
    assert.equal(min, 24n * 26n * 26n * 10n * 32n);
    const max = countPasswords(planPassword(all(config.length.max), config));
    assert.ok(max < 94n ** 128n && max > 93n ** 128n, "length 128: nearly every string is valid");
    // Numbers pinned to 17 leaves exactly one position for each other type:
    // 20 * 19 * 18 arrangements, 10^17 digit fillings and one character of each of the rest.
    const pinned = countPasswords(
      planPassword(all(20, { counts: counts(20, { numbers: { min: 17, max: 17 } }) }), config),
    );
    assert.equal(pinned, 6840n * 10n ** 17n * 26n * 26n * 32n);
    const only = countPasswords(
      planPassword(none(20, { numbers: true, counts: counts(20, { numbers: { min: 20, max: 20 } }) }), config),
    );
    assert.equal(only, 10n ** 20n);
    const exact = countPasswords(
      planPassword(all(20, { counts: counts(20, { symbols: { min: 1, max: 1 } }) }), config),
    );
    // 20 positions for the one symbol, 32 symbols, then 19 characters over the
    // 62 letters and digits with each of the three present.
    const rest = 62n ** 19n - 2n * 36n ** 19n - 52n ** 19n + 26n ** 19n * 2n + 10n ** 19n;
    assert.equal(exact, 20n * 32n * rest);
  });

  for (const constrainedType of ["numbers", "lowercase"] as const) {
    test(`is pure, deterministic and type-order invariant with ${constrainedType} Min 5 and symbols Max 1`, () => {
      const options = all(20, { counts: counts(20, { [constrainedType]: { min: 5 }, symbols: { max: 1 } }) });
      const plan = planPassword(options, config);
      const freeSizes = plan.types
        .filter((type) => type.min === 1 && type.max === plan.length)
        .map((type) => type.characters.length);
      assert.deepEqual(freeSizes, constrainedType === "lowercase" ? [26, 10] : [26, 26]);
      const before = structuredClone(plan);
      const first = countPasswords(plan);
      for (const types of [[...plan.types].reverse(), [...plan.types.slice(1), ...plan.types.slice(0, 1)]]) {
        assert.notDeepEqual(types, plan.types, "the type order actually changes");
        assert.equal(countPasswords({ ...plan, types }), first, "type order preserves the exact count");
      }
      assert.equal(countPasswords(plan), first);
      assert.deepEqual(plan, before);
      assert.ok(first > 0n);
    });
  }
});

describe("fails closed without Web Crypto even when a class has one character (S1, every call draws)", () => {
  // One class of one character, only that class selected: every draw has one
  // possible result, which must still come from the source.
  const one = tiny({ numbers: "7" });
  const options = none(4, { numbers: true });

  test("with a working source the only possible password is produced, drawing a word for every forced choice", () => {
    // One word for the count vector (the only vector, drawn through
    // randomBigInt(1)), three for the Fisher-Yates shuffle of four labels, and
    // one per character pick from the one-character set.
    const source = wordsSource([0xdeadbeef, 0, 0, 0, 0, 0xffffffff, 0x80000000, 1]);
    assert.equal(generatePassword(options, one, source), "7777");
    assert.equal(source.consumed, 8);
    const many = wordsSource(new Array(16).fill(0));
    assert.deepEqual(generatePasswords(options, one, 2, many), ["7777", "7777"]);
    assert.equal(many.consumed, 16);
  });

  test("with Web Crypto missing, incomplete, not a function, or throwing, nothing is produced", () => {
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
    for (const [label, cryptoObject] of broken) {
      const source = webCryptoFrom(cryptoObject);
      assert.throws(() => generatePassword(options, one, source), RandomUnavailableError, label);
      assert.throws(() => generatePasswords(options, one, 1, source), RandomUnavailableError, label);
      assert.throws(() => generatePasswords(options, one, 5, source), RandomUnavailableError, label);
      assert.throws(() => generatePassword(all(128), config, source), RandomUnavailableError, label);
    }
  });

  test("a source that is never called means nothing was generated", () => {
    assert.throws(() => generatePassword(options, one, neverSource), /neverSource/);
    assert.throws(() => generatePassword(none(1, { numbers: true }), one, neverSource), /neverSource/);
  });

  test("the same holds with the look-alike option leaving one character in a class", () => {
    const narrowed = tiny({ numbers: "07" }, { lookAlikes: "0" });
    const narrowedOptions = { ...options, excludeLookAlikes: true };
    assert.equal(planPassword(narrowedOptions, narrowed).pool.length, 1);
    assert.throws(() => generatePassword(narrowedOptions, narrowed, webCryptoFrom(undefined)), RandomUnavailableError);
    assert.equal(generatePassword(narrowedOptions, narrowed, wordsSource(new Array(8).fill(0))), "7777");
  });
});

describe("generatePassword with a deterministic source: count vector, positions, then characters (R10, R11a)", () => {
  // Pool "ab12" (lowercase "ab", numbers "12"), length 3. The 48 valid
  // strings split into 24 with one digit and 24 with two. The draw is:
  //
  // 1. The numbers count, from a uniform BigInt below 48: six bits of one
  //    word (candidates 48 to 63 are rejected). 0 to 23 gives one digit,
  //    24 to 47 gives two.
  // 2. The lowercase count, forced to the rest: one word drawn and discarded
  //    (the only candidate), through randomBigInt over a power of two.
  // 3. A Fisher-Yates shuffle of the three labels [lower, lower, digit] or
  //    [lower, digit, digit]: randomInt(3) (two bits, 3 rejected) then
  //    randomInt(2) (one bit).
  // 4. One pick per position from the two-character set of its type: one bit each.
  const two = tiny({ lowercase: "ab", numbers: "12" });
  const options = none(3, { lowercase: true, numbers: true });
  const words = (vector: number, lowerDiscard: number, j2: number, j1: number, picks: number[]) => [
    topBits(vector, 6),
    lowerDiscard,
    topBits(j2, 2),
    topBits(j1, 1),
    ...picks.map((bit) => topBits(bit, 1)),
  ];

  test("one digit: the labels start as [lower, lower, digit] and the shuffle places the digit", () => {
    // j2 = 2 keeps position 2, j1 = 0 swaps positions 1 and 0 (both lower).
    const source = wordsSource(words(0, 0, 2, 0, [0, 1, 0]));
    assert.equal(generatePassword(options, two, source), "ab1");
    assert.equal(source.consumed, 7);
    // j2 = 0 moves the digit to position 0; j1 = 1 keeps position 1.
    assert.equal(generatePassword(options, two, wordsSource(words(23, 0xffffffff, 0, 1, [1, 0, 1]))), "2ab");
    // j2 = 1 moves the digit to position 1, then j1 = 0 swaps it to position 0.
    assert.equal(generatePassword(options, two, wordsSource(words(5, 7, 1, 0, [0, 1, 1]))), "1bb");
  });

  test("two digits: candidates 24 to 47 give [lower, digit, digit]", () => {
    assert.equal(generatePassword(options, two, wordsSource(words(24, 0, 2, 1, [0, 0, 1]))), "a12");
    assert.equal(generatePassword(options, two, wordsSource(words(47, 0, 0, 1, [1, 1, 0]))), "22a");
  });

  test("a count-vector candidate of 48 or more is rejected and a fresh word drawn, never reduced", () => {
    const source = wordsSource([topBits(63, 6), topBits(48, 6), ...words(24, 0, 2, 1, [0, 0, 1]).slice(0)]);
    assert.equal(generatePassword(options, two, source), "a12");
    assert.equal(source.consumed, 9);
  });

  test("the digit can land at every position: nothing is at a fixed position", () => {
    const positions = new Set<number>();
    for (let j2 = 0; j2 < 3; j2 += 1) {
      for (let j1 = 0; j1 < 2; j1 += 1) {
        const password = generatePassword(options, two, wordsSource(words(0, 0, j2, j1, [0, 0, 0])));
        positions.add(password.indexOf("1"));
      }
    }
    assert.deepEqual([...positions].sort(), [0, 1, 2]);
  });

  test("every one of the 48 valid strings is reached by some draw sequence, and nothing else", () => {
    const seen = new Set<string>();
    for (let vector = 0; vector < 48; vector += 1) {
      for (let j2 = 0; j2 < 3; j2 += 1) {
        for (let j1 = 0; j1 < 2; j1 += 1) {
          for (let bits = 0; bits < 8; bits += 1) {
            const picks = [bits & 1, (bits >> 1) & 1, (bits >> 2) & 1];
            seen.add(generatePassword(options, two, wordsSource(words(vector, 0, j2, j1, picks))));
          }
        }
      }
    }
    assert.equal(seen.size, 48);
    assert.deepEqual([...seen].sort(), enumerate(planPassword(options, two)).sort());
  });

  test("Simple and Complex symbols satisfy the rule together, as one type", () => {
    // Pool "a!/" (lowercase "a", simple "!", complex "/"), length 2: the four
    // valid strings have one letter and one symbol. The count vector is
    // forced (one word each for the two steps), the shuffle is randomInt(2),
    // and the symbol pick is one of two with one bit; the letter pick draws
    // and discards one word.
    const three = tiny({ lowercase: "a", simple: "!", complex: "/" });
    const symbols = none(2, { lowercase: true, simple: true, complex: true });
    assert.equal(planPassword(symbols, three).types.length, 2);
    assert.equal(countPasswords(planPassword(symbols, three)), 4n);
    const source = wordsSource([0, 0, topBits(1, 1), 0, topBits(1, 1)]);
    assert.equal(generatePassword(symbols, three, source), "a/");
    assert.equal(source.consumed, 5);
    assert.equal(generatePassword(symbols, three, wordsSource([0, 0, topBits(0, 1), topBits(0, 1), 0])), "!a");
  });

  test("S1: Web Crypto missing or failing propagates as RandomUnavailableError, with no output", () => {
    assert.throws(() => generatePassword(ALL, config, webCryptoFrom(undefined)), RandomUnavailableError);
    assert.throws(
      () =>
        generatePassword(
          ALL,
          config,
          webCryptoFrom({
            getRandomValues() {
              throw new Error("broken");
            },
          }),
        ),
      RandomUnavailableError,
    );
  });

  test("the plan is not changed by generating", () => {
    const plan = planPassword(options, two);
    const before = structuredClone(plan);
    generatePassword(options, two, wordsSource(words(0, 0, 2, 0, [0, 1, 0])));
    assert.deepEqual(plan, before);
  });
});

describe("generatePassword with Web Crypto and the shipped configuration", () => {
  test("the defaults give length 20 from the 94-character pool with every type present, every time", () => {
    const options = defaultOptions(config);
    for (let i = 0; i < 500; i += 1) {
      const password = generatePassword(options, config);
      assert.equal(password.length, 20);
      assert.deepEqual(typesIn(password), new Set(["lowercase", "uppercase", "numbers", "symbols"]));
    }
  });

  test("length 4 with every type on gives one of each type, every time (the hardest case for R10)", () => {
    const options = all(4);
    for (let i = 0; i < 300; i += 1) {
      const password = generatePassword(options, config);
      assert.equal(password.length, 4);
      assert.equal(typesIn(password).size, 4);
    }
  });

  test("every length from the minimum to the maximum is honoured", () => {
    for (let length = config.length.min; length <= config.length.max; length += 1) {
      assert.equal(generatePassword(all(length), config).length, length);
    }
  });

  test("Min and Max limits hold in every password, including Min = Max, Max 0 and Min 0", () => {
    const cases: Array<[PasswordOptions, (found: Record<PasswordTypeName, number>) => boolean]> = [
      [all(20, { counts: counts(20, { symbols: { max: 1 } }) }), (f) => f.symbols === 1],
      [all(20, { counts: counts(20, { numbers: { min: 5 } }) }), (f) => f.numbers >= 5],
      [
        all(20, { counts: counts(20, { numbers: { min: 5 }, symbols: { max: 1 } }) }),
        (f) => f.numbers >= 5 && f.symbols === 1,
      ],
      [all(20, { counts: counts(20, { uppercase: { min: 7, max: 7 } }) }), (f) => f.uppercase === 7],
      [all(20, { counts: counts(20, { numbers: { min: 0, max: 0 } }) }), (f) => f.numbers === 0],
      [
        all(8, {
          counts: counts(8, {
            lowercase: { min: 2, max: 2 },
            uppercase: { min: 2, max: 2 },
            numbers: { min: 2, max: 2 },
            symbols: { min: 2, max: 2 },
          }),
        }),
        (f) => Object.values(f).every((c) => c === 2),
      ],
      [
        all(20, {
          counts: counts(20, {
            lowercase: { min: 0 },
            uppercase: { min: 0 },
            numbers: { min: 0 },
            symbols: { min: 17 },
          }),
        }),
        (f) => f.symbols >= 17,
      ],
      [
        all(128, { counts: counts(128, { lowercase: { max: 2 }, uppercase: { max: 2 }, numbers: { max: 2 } }) }),
        (f) => f.lowercase <= 2 && f.uppercase <= 2 && f.numbers <= 2 && f.symbols >= 122,
      ],
    ];
    for (const [options, holds] of cases) {
      for (let i = 0; i < 100; i += 1) {
        const password = generatePassword(options, config);
        assert.equal(password.length, options.length);
        assert.ok(holds(countsIn(password)), `limits hold for ${JSON.stringify(options.counts)}`);
      }
    }
  });

  test("with the look-alike option on, none of the eight characters ever appears, and limits still hold", () => {
    const options = all(128, { excludeLookAlikes: true, counts: counts(128, { numbers: { min: 1, max: 3 } }) });
    for (let i = 0; i < 50; i += 1) {
      const password = generatePassword(options, config);
      for (const character of LOOK_ALIKES) assert.ok(!password.includes(character), `${character} in output`);
      assert.deepEqual(typesIn(password), new Set(["lowercase", "uppercase", "numbers", "symbols"]));
      assert.ok(countsIn(password).numbers <= 3);
    }
  });

  test("only the selected classes appear", () => {
    const cases: Array<[PasswordOptions, string]> = [
      [none(12, { lowercase: true }), "lowercase"],
      [none(12, { uppercase: true }), "uppercase"],
      [none(12, { numbers: true }), "numbers"],
      [none(12, { simple: true }), "symbols"],
      [none(12, { simple: true, complex: true }), "symbols"],
    ];
    for (const [options, type] of cases) {
      for (let i = 0; i < 50; i += 1) {
        assert.deepEqual(typesIn(generatePassword(options, config)), new Set([type]));
      }
    }
    for (let i = 0; i < 50; i += 1) {
      const simpleOnly = generatePassword(all(64, { complex: false }), config);
      for (const character of config.characters.complex) assert.ok(!simpleOnly.includes(character));
    }
  });

  test("never contains a space or a non-ASCII character (R7)", () => {
    for (let i = 0; i < 50; i += 1) assert.match(generatePassword(all(128), config), /^[!-~]+$/);
  });

  test("every pick draws from the source: more than one word per character", () => {
    const source = counting(webCrypto);
    const password = generatePassword(all(32), config, source);
    assert.equal(password.length, 32);
    assert.ok(source.consumed >= 32 + 31 + 1, "a pick per character, a shuffle step per label, and the count draws");
  });
});

describe("generatePasswords: independent results for the main and extra results (R20)", () => {
  const two = tiny({ lowercase: "ab", numbers: "12" });
  const options = none(2, { lowercase: true, numbers: true });

  test("gives exactly count passwords, each from its own fresh draws, in order", () => {
    // Length 2: the count vector is forced (2 valid vectors? no: one letter
    // and one digit is the only vector, so one word per step, discarded),
    // then randomInt(2) for the shuffle and one bit per pick.
    const one = (j: number, letter: number, digit: number) => [
      0,
      0,
      topBits(j, 1),
      ...(j === 0 ? [topBits(digit, 1), topBits(letter, 1)] : [topBits(letter, 1), topBits(digit, 1)]),
    ];
    const source = wordsSource([...one(1, 0, 0), ...one(0, 1, 1), ...one(1, 1, 0)]);
    assert.deepEqual(generatePasswords(options, two, 3, source), ["a1", "2b", "b1"]);
    assert.equal(source.consumed, 15);
  });

  test("count 0 gives an empty list without drawing", () => {
    assert.deepEqual(generatePasswords(options, two, 0, neverSource), []);
  });

  test("the shipped extra-results count gives that many distinct, valid passwords", () => {
    const passwords = generatePasswords(defaultOptions(config), config, shipped.extraResults);
    assert.equal(passwords.length, shipped.extraResults);
    assert.equal(new Set(passwords).size, passwords.length);
    for (const password of passwords) assert.equal(typesIn(password).size, 4);
  });

  test("a bad count is refused before any randomness is drawn", () => {
    for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined, 2 ** 53]) {
      assert.throws(
        () => generatePasswords(options, two, count as unknown as number, neverSource),
        (error: unknown) => error instanceof PasswordError,
        `count ${String(count)}`,
      );
    }
  });

  test("a bad request is refused before any randomness is drawn, whatever the count", () => {
    assert.throws(
      () => generatePasswords(none(1, { lowercase: true, numbers: true }), two, 5, neverSource),
      LengthBelowTypesError,
    );
    assert.throws(
      () => generatePasswords(none(0, { lowercase: true, numbers: true }), two, 0, neverSource),
      LengthOutOfRangeError,
    );
  });

  test("if any one result fails, the whole call throws and nothing is returned", () => {
    const source = wordsSource([...new Array(5).fill(0)]); // enough for one password, not two
    assert.throws(() => generatePasswords(options, two, 2, source), /exhausted/);
  });

  test("generates six passwords of length 128 under tight limits in well under a second", () => {
    const options = all(128, { counts: counts(128, { numbers: { min: 5 }, symbols: { max: 1 } }) });
    const started = performance.now();
    const passwords = generatePasswords(options, config, 6);
    const elapsed = performance.now() - started;
    assert.equal(passwords.length, 6);
    for (const password of passwords) {
      const found = countsIn(password);
      assert.ok(found.numbers >= 5 && found.symbols === 1 && found.lowercase >= 1 && found.uppercase >= 1);
    }
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(1)} ms`);
  });
});
