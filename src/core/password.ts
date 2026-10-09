// The password generator (requirements R6 to R11, R11a, R11b, R7a and S3).
// Pure and DOM-free: it is built on src/core/random.ts and the validated
// configuration in src/config/, and nothing else. The interface layer (M2)
// owns the controls, the messages and the clipboard; this module owns the
// rules.
//
// What a valid password is
// ------------------------
// The pool is the union of the selected character classes from the
// configuration (R7), minus the look-alike set when that option is on (R7a).
// Simple and Complex symbols together are one "symbols" type, so there are
// at most four types: lowercase, uppercase, numbers and symbols. Each
// selected type has a Min and a Max count (R11a). A password of the chosen
// length is valid when, for every selected type, the number of its
// characters in the password is between that type's Min and Max. With the
// defaults, Min 1 and Max equal to the length, this is exactly the
// at-least-one-of-each rule of R10.
//
// How a password is made
// ----------------------
// Every valid password must be exactly equally likely (R10, R11a), so that
// the entropy of item 9, log2 of `countPasswords`, is honest. Three steps,
// each exactly uniform over its own choices:
//
// 1. The count vector. For a vector c = (c_1, ..., c_T) of per-type counts
//    that sums to the length L, the number of valid passwords with exactly
//    those counts is W(c) = L! / (c_1! ... c_T!) * s_1^c_1 * ... * s_T^c_T,
//    where s_t is the size of type t's character set: the first factor is
//    the number of ways to assign the types to positions, the rest the ways
//    to fill each position from its type. The vector is drawn with
//    probability W(c) / N, where N is the sum of W over every vector that
//    meets the Min and Max limits (the count `countPasswords` reports). The
//    draw is done one type at a time from a table of exact BigInt partial
//    sums (see `countTable`), and each step is a weighted choice made by
//    drawing a uniform BigInt below the step's total with `randomBigInt`,
//    which rejects rather than wraps, so no weight is rounded or skewed.
// 2. The positions. The multiset of type labels (c_t copies of each type)
//    is put into a uniformly random order by `shuffle`, a Fisher-Yates
//    shuffle built on the same unbiased `randomInt`. Every one of the
//    L! / (c_1! ... c_T!) distinct arrangements is equally likely.
// 3. The characters. Each position is filled by a uniform `pick` from the
//    set of its type.
//
// Multiplying the three probabilities gives, for any valid password p with
// count vector c: W(c)/N * (c_1! ... c_T!)/L! * 1/(s_1^c_1 ... s_T^c_T) = 1/N.
// Every valid password is exactly equally likely, whatever the limits.
// With the first-symbol restriction, generationSpace partitions by the
// first type and reuses these exact composition tables for the suffix.
//
// Three tempting alternatives are never used, because each is biased:
// putting one character of each type at fixed positions, picking the forced
// characters first and shuffling them in, and choosing the count vector
// uniformly among the allowed vectors instead of in proportion to W.
// tests/unit/password-stats.test.ts shows each of them failing the
// distribution tests that this generator passes.
//
// There is no regeneration and no retry bound. The only loops that depend on
// random values are the rejection loops inside `randomInt` and
// `randomBigInt`, which accept at least half of all draws, whatever the
// request; nothing here can stall or fall back to a biased method (S3).
//
// Everything that can be wrong with the request is checked before any
// randomness is drawn, and each problem has its own error class so the
// interface can show the right message (R9, R11, R11b). No error message
// and no thrown value ever contains a generated password (S6).

import type { Config } from "../config/validate.ts";
import { pick, type RandomSource, randomBigInt, shuffle, webCrypto } from "./random.ts";

/** The `password` section of the validated configuration (C1, C2). */
export type PasswordConfig = Config["password"];

/** The five character classes of R7, as named in the configuration. */
export type CharacterClass = keyof PasswordConfig["characters"];

/** The types that the count rules (R10, R11a) apply to: the symbol classes are one type. */
export type PasswordTypeName = "lowercase" | "uppercase" | "numbers" | "symbols";

/** The four type names in configuration order. */
export const PASSWORD_TYPE_NAMES: readonly PasswordTypeName[] = ["lowercase", "uppercase", "numbers", "symbols"];

/** The Min and Max count of one type (R11a). */
export interface TypeCount {
  readonly min: number;
  readonly max: number;
}

/** The Min and Max count of every type, selected or not (R11a). */
export type PasswordCounts = Readonly<Record<PasswordTypeName, TypeCount>>;

/** The user-changeable settings of the password generator (R6, R7, R7a, R11a). */
export interface PasswordOptions {
  readonly length: number;
  readonly lowercase: boolean;
  readonly uppercase: boolean;
  readonly numbers: boolean;
  readonly simple: boolean;
  readonly complex: boolean;
  readonly excludeLookAlikes: boolean;
  readonly dontStartWithSymbol: boolean;
  /** Counts of unselected types are carried along but not checked or used. */
  readonly counts: PasswordCounts;
}

/** One selected type: its name, the characters of it that are in the pool, and its effective limits. */
export interface PasswordType {
  readonly name: PasswordTypeName;
  readonly characters: readonly string[];
  /** The Min count, as requested. */
  readonly min: number;
  /** The Max count, after the R11b adjustment. */
  readonly max: number;
}

/**
 * A request that has passed every check: the length, the pool each character
 * is picked from, and the selected types with their effective limits. Item 9
 * (entropy) can count the valid passwords from this alone (`countPasswords`).
 */
export interface PasswordPlan {
  readonly length: number;
  /** Every character the password can contain, in configuration order, without duplicates. */
  readonly pool: readonly string[];
  /** The selected types in configuration order, each with at least one character. Never empty. */
  readonly types: readonly PasswordType[];
  /** Effective first-position constraint, after checking feasibility. */
  readonly dontStartWithSymbol?: boolean;
  /** Requested constraint skipped because the normalized limits force all symbols. */
  readonly startSymbolRuleSkipped?: boolean;
}

/** Base class of every error this module throws. Nothing was generated. */
export class PasswordError extends Error {
  override readonly name: string = "PasswordError";
}

/** R9: every character type is off, so there is nothing to pick from. */
export class NoTypesSelectedError extends PasswordError {
  override readonly name: string = "NoTypesSelectedError";
}

/**
 * R11, R11b: the Min counts of the selected types add up to more than the
 * length, so they cannot all be met. With the default Min of 1 for each
 * type this is R11, the length being less than the number of selected
 * types, and `minimums` equals `types`.
 */
export class LengthBelowTypesError extends PasswordError {
  override readonly name: string = "LengthBelowTypesError";
  readonly length: number;
  /** The number of selected types. */
  readonly types: number;
  /** The sum of the Min counts of the selected types. */
  readonly minimums: number;
  constructor(length: number, types: number, minimums: number) {
    super(
      `a password of length ${length} cannot contain the ${minimums} characters that the minimum counts of ${types} character types require`,
    );
    this.length = length;
    this.types = types;
    this.minimums = minimums;
  }
}

/** R6: the length is not an integer within the configured bounds. */
export class LengthOutOfRangeError extends PasswordError {
  override readonly name: string = "LengthOutOfRangeError";
  readonly min: number;
  readonly max: number;
  constructor(min: number, max: number) {
    super(`length must be an integer from ${min} to ${max}`);
    this.min = min;
    this.max = max;
  }
}

/** R8: Complex symbols are on while Simple symbols are off, which the symbol rule forbids. */
export class SymbolRuleError extends PasswordError {
  override readonly name: string = "SymbolRuleError";
}

/** R11a: the Min or Max count of a selected type is not an integer from `min` to `max` (0 to the length). */
export class CountRangeError extends PasswordError {
  override readonly name: string = "CountRangeError";
  readonly type: PasswordTypeName;
  readonly field: "min" | "max";
  readonly min: number;
  readonly max: number;
  constructor(type: PasswordTypeName, field: "min" | "max", min: number, max: number) {
    super(`the ${field === "min" ? "Min" : "Max"} count for ${type} must be an integer from ${min} to ${max}`);
    this.type = type;
    this.field = field;
    this.min = min;
    this.max = max;
  }
}

/** R11b: the Min count of a selected type is above its Max count. */
export class MinAboveMaxError extends PasswordError {
  override readonly name: string = "MinAboveMaxError";
  readonly type: PasswordTypeName;
  readonly min: number;
  readonly max: number;
  constructor(type: PasswordTypeName, min: number, max: number) {
    super(`the Min count for ${type} (${min}) is above its Max count (${max})`);
    this.type = type;
    this.min = min;
    this.max = max;
  }
}

/** The configured default counts resolved for a length: a null Max in the configuration means the length (R11a, C1). */
export function defaultCounts(config: PasswordConfig, length: number): PasswordCounts {
  const resolve = (name: PasswordTypeName): TypeCount => {
    const { min, max } = config.counts[name];
    return { min, max: max === null ? length : Math.min(max, length) };
  };
  return {
    lowercase: resolve("lowercase"),
    uppercase: resolve("uppercase"),
    numbers: resolve("numbers"),
    symbols: resolve("symbols"),
  };
}

/** The options the page starts with: the configured defaults (R5, R6, R7, R7a, R11a). */
export function defaultOptions(config: PasswordConfig): PasswordOptions {
  return {
    length: config.length.default,
    lowercase: config.enabled.lowercase,
    uppercase: config.enabled.uppercase,
    numbers: config.enabled.numbers,
    simple: config.enabled.simple,
    complex: config.enabled.complex,
    excludeLookAlikes: config.excludeLookAlikes,
    dontStartWithSymbol: config.dontStartWithSymbol,
    counts: defaultCounts(config, config.length.default),
  };
}

/** Whether the symbol rule (R8) holds: Complex on implies Simple on. Both off is fine. */
export function symbolRuleHolds(options: PasswordOptions): boolean {
  return !(options.complex === true && options.simple !== true);
}

/**
 * The symbol rule of R8, "Complex implies Simple", as a pure function for the
 * interface to call after the user changes a symbol checkbox. `toggled` names
 * the checkbox that was just changed and `options` already holds its new
 * value; the result is a new options object with the rule applied:
 *
 * - Checking Complex while Simple is off turns Simple on too.
 * - Unchecking Simple while Complex is on turns Complex off too.
 * - Unchecking Complex leaves Simple as it is.
 * - Checking Simple changes nothing else. Both can be off.
 */
export function applySymbolRule(options: PasswordOptions, toggled: "simple" | "complex"): PasswordOptions {
  if (toggled === "complex" && options.complex && !options.simple) return { ...options, simple: true };
  if (toggled === "simple" && !options.simple && options.complex) return { ...options, complex: false };
  return { ...options };
}

/** The characters of one class, minus the look-alikes when that option is on (R7, R7a). */
function classCharacters(config: PasswordConfig, name: CharacterClass, excludeLookAlikes: boolean): string[] {
  const characters = Array.from(config.characters[name]);
  if (!excludeLookAlikes) return characters;
  const excluded = new Set(config.lookAlikes);
  return characters.filter((character) => !excluded.has(character));
}

/** A whole number from `min` to `max`, as a type guard for values read from options. */
function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Checks a request against the rules and resolves it into a plan. Nothing
 * random happens here. The checks run in this order, and the first failure
 * is thrown:
 *
 * 1. `length` is an integer from `config.length.min` to `config.length.max`,
 *    else `LengthOutOfRangeError` (R6). A non-number, NaN, Infinity or a
 *    fraction fails this check.
 * 2. Complex symbols on with Simple symbols off is `SymbolRuleError` (R8).
 * 3. No class on is `NoTypesSelectedError` (R9).
 * 4. For each selected type in configuration order: a Min that is not an
 *    integer from 0 to the length is `CountRangeError` for `min`, then a
 *    Max that is not an integer from 0 to the length is `CountRangeError`
 *    for `max`, then a Min above its Max is `MinAboveMaxError` (R11a, R11b).
 * 5. Min counts adding up to more than the length is `LengthBelowTypesError`
 *    (R11, R11b), where Simple and Complex together count as one type.
 *
 * Then the R11b adjustment: if the Max counts add up to less than the
 * length, the Max of lowercase, or of the first selected type in the order
 * uppercase, numbers, symbols when lowercase is off, is raised until they
 * cover it. The plan's types carry the adjusted Max; `normalizeCounts`
 * returns it for the interface to show.
 *
 * A class is selected only when its option is exactly `true`, so a corrupt
 * saved setting (R26) can only turn a class off, never on. The counts of a
 * type that is not selected are neither checked nor used.
 */
export function planPassword(options: PasswordOptions, config: PasswordConfig): PasswordPlan {
  const { min, max } = config.length;
  const length = options.length;
  if (!isIntegerIn(length, min, max)) throw new LengthOutOfRangeError(min, max);
  if (!symbolRuleHolds(options)) throw new SymbolRuleError("Complex symbols require Simple symbols");

  const exclude = options.excludeLookAlikes === true;
  const selected: Array<{ name: PasswordTypeName; characters: string[] }> = [];
  for (const name of ["lowercase", "uppercase", "numbers"] as const) {
    if (options[name] === true) selected.push({ name, characters: classCharacters(config, name, exclude) });
  }
  const symbols = [
    ...(options.simple === true ? classCharacters(config, "simple", exclude) : []),
    ...(options.complex === true ? classCharacters(config, "complex", exclude) : []),
  ];
  if (options.simple === true || options.complex === true) selected.push({ name: "symbols", characters: symbols });

  if (selected.length === 0) throw new NoTypesSelectedError("no character type is selected");
  for (const type of selected) {
    // The validator refuses a configuration where this can happen; fail closed anyway.
    if (type.characters.length === 0) throw new PasswordError(`the ${type.name} type has no characters`);
  }
  const pool = selected.flatMap((type) => type.characters);
  if (new Set(pool).size !== pool.length) throw new PasswordError("character classes overlap");

  const counts = typeof options.counts === "object" && options.counts !== null ? options.counts : undefined;
  const limits: Array<{ min: number; max: number }> = [];
  for (const type of selected) {
    const count: Partial<TypeCount> | undefined = counts?.[type.name];
    const typeMin = count?.min;
    if (!isIntegerIn(typeMin, 0, length)) throw new CountRangeError(type.name, "min", 0, length);
    const typeMax = count?.max;
    if (!isIntegerIn(typeMax, 0, length)) throw new CountRangeError(type.name, "max", 0, length);
    if (typeMin > typeMax) throw new MinAboveMaxError(type.name, typeMin, typeMax);
    limits.push({ min: typeMin, max: typeMax });
  }
  const minimums = limits.reduce((sum, limit) => sum + limit.min, 0);
  if (minimums > length) throw new LengthBelowTypesError(length, selected.length, minimums);

  // R11b: raise the first selected type's Max (lowercase first, as `selected`
  // is in configuration order) until the Max counts cover the length.
  const maximums = limits.reduce((sum, limit) => sum + limit.max, 0);
  if (maximums < length) {
    const first = limits[0] as { min: number; max: number };
    first.max += length - maximums;
  }

  const types = selected.map((type, index) => {
    const limit = limits[index] as { min: number; max: number };
    return { name: type.name, characters: type.characters, min: limit.min, max: limit.max };
  });
  // After normalization, a non-symbol can lead iff reserving one of that
  // type fits both its Max and the total minimums. Otherwise keep the full
  // valid space (including symbols-only and symbols Min = length).
  const canStart = types.some(
    (type) => type.name !== "symbols" && type.max > 0 && minimums + (type.min === 0 ? 1 : 0) <= length,
  );
  const requested = options.dontStartWithSymbol === true;
  return {
    length,
    pool,
    types,
    dontStartWithSymbol: requested && canStart,
    startSymbolRuleSkipped: requested && !canStart,
  };
}

/**
 * The R11b adjustment as a pure function for the interface: the counts of
 * `options` with the Max of one type raised, if the Max counts of the
 * selected types added up to less than the length, and otherwise unchanged.
 * The counts of unselected types are returned as they were. Nothing random
 * happens here.
 *
 * @throws the same errors as `planPassword`, for the same requests.
 */
export function normalizeCounts(options: PasswordOptions, config: PasswordConfig): PasswordCounts {
  const plan = planPassword(options, config);
  const adjusted: Record<PasswordTypeName, TypeCount> = { ...options.counts };
  for (const type of plan.types) adjusted[type.name] = { min: type.min, max: type.max };
  return adjusted;
}

// Rows of Pascal's triangle as BigInts, extended on demand and kept for the
// life of the module: `binomial(n, k)` is C(n, k). The rows are plain data
// that depend on nothing, so sharing them changes no result.
const pascal: bigint[][] = [[1n]];
function binomial(n: number, k: number): bigint {
  while (pascal.length <= n) {
    const previous = pascal[pascal.length - 1] as bigint[];
    const row = new Array<bigint>(previous.length + 1).fill(1n);
    for (let i = 1; i < previous.length; i += 1) row[i] = (previous[i - 1] as bigint) + (previous[i] as bigint);
    pascal.push(row);
  }
  return (pascal[n] as bigint[])[k] as bigint;
}

/** One type as the count table sees it: its position in the plan, its character-set size and limits. */
interface TableType {
  readonly index: number;
  readonly size: bigint;
  readonly min: number;
  readonly max: number;
  /** size^c for c from 0 to the length. */
  readonly powers: readonly bigint[];
}

/**
 * The partial sums that the count and the count-vector draw are built on.
 *
 * The types are taken in an order of this table's choosing, and
 * `layers[k][n]` is the number of strings of length n over the first k
 * types in that order whose per-type counts meet the limits of those k
 * types (so layers[0] is 1 at n = 0 and 0 elsewhere, and layers[T][L] is
 * the count of valid passwords). Each layer follows from the one before:
 *
 *   layers[k][n] = sum over c from min_k to min(max_k, n) of
 *                  layers[k-1][n-c] * C(n, c) * size_k^c
 *
 * since a string of length n with c characters of type k is a choice of
 * which c of the n positions hold them, a filling of those positions from
 * the type's set, and a valid string of length n - c over the earlier types.
 *
 * Cost. The order puts the "free" types first, those whose limits cannot
 * bind (Min 0 or 1, Max equal to the length), then the bounded types from
 * the narrowest range to the widest. For the prefix of free types the sum
 * has a closed form by inclusion-exclusion over the types that must appear:
 *
 *   layers[k][n] = sum over subsets S of the required types among the first
 *                  k of (-1)^|S| * (U_k - size(S))^n,   U_k = total size of the first k
 *
 * which costs a few powers per entry instead of a sum. For the last type
 * only the entry at n = L is needed, and the explicit sum for a narrow
 * bounded type is short. The order changes which partial sums are formed,
 * not the final count, and the draw uses the same order, so the probability
 * of each count vector is the same whatever order is chosen.
 */
interface CountTable {
  readonly length: number;
  readonly types: readonly TableType[];
  readonly layers: readonly (readonly bigint[])[];
}

/** The weight of c characters of type `type` joining a valid string of length n - c: C(n, c) * size^c. */
function joinWeight(type: TableType, n: number, c: number): bigint {
  return binomial(n, c) * (type.powers[c] as bigint);
}

function countTable(plan: PasswordPlan): CountTable {
  const length = plan.length;
  const all = plan.types.map((type, index): TableType => {
    const size = BigInt(type.characters.length);
    const powers = [1n];
    for (let c = 1; c <= length; c += 1) powers.push((powers[c - 1] as bigint) * size);
    return { index, size, min: type.min, max: type.max, powers };
  });
  const isFree = (type: TableType) => type.min <= 1 && type.max >= length;
  const free = all.filter(isFree);
  const bounded = all.filter((type) => !isFree(type)).sort((a, b) => a.max - a.min - (b.max - b.min));
  const types = [...free, ...bounded];
  const layers: bigint[][] = [new Array<bigint>(length + 1).fill(0n)];
  (layers[0] as bigint[])[0] = 1n;

  for (let k = 1; k <= types.length; k += 1) {
    const type = types[k - 1] as TableType;
    const previous = layers[k - 1] as bigint[];
    const layer = new Array<bigint>(length + 1).fill(0n);
    if (k <= free.length && k < types.length) {
      const prefix = types.slice(0, k);
      const total = prefix.reduce((sum, t) => sum + t.size, 0n);
      const required = prefix.filter((t) => t.min === 1).map((t) => t.size);
      for (let subset = 0; subset < 1 << required.length; subset += 1) {
        let base = total;
        let sign = 1n;
        for (let i = 0; i < required.length; i += 1) {
          if (subset & (1 << i)) {
            base -= required[i] as bigint;
            sign = -sign;
          }
        }
        let power = 1n;
        for (let n = 0; n <= length; n += 1) {
          layer[n] = (layer[n] as bigint) + sign * power;
          power *= base;
        }
      }
    } else {
      for (let n = k === types.length ? length : 0; n <= length; n += 1) {
        let sum = 0n;
        const high = Math.min(type.max, n);
        for (let c = type.min; c <= high; c += 1) {
          const earlier = previous[n - c] as bigint;
          if (earlier !== 0n) sum += earlier * joinWeight(type, n, c);
        }
        layer[n] = sum;
      }
    }
    layers.push(layer);
  }
  return { length, types, layers };
}

/**
 * The exact number of valid passwords for a plan: every string of the
 * plan's length over its pool whose count of each type is within that
 * type's limits and whose first character meets the plan's effective rule.
 * For item 9, the entropy is log2 of this number. Pure:
 * nothing random happens here, and the same plan always gives the same
 * count.
 */
export function countPasswords(plan: PasswordPlan): bigint {
  return generationSpace(plan).total;
}

/**
 * Partition the constrained space by first-character type. For type t, remove
 * one position and reduce its Min/Max by one: weight = s_t * N_suffix(t).
 * Draw a branch with this exact weight, then its character and suffix uniformly.
 * Each full password has probability (s_t*N_suffix/N)/s_t/N_suffix = 1/N.
 * No forced-character shuffle or output rejection is needed. The unconstrained
 * path uses the original composition table. Batch generation shares all tables.
 */
interface GenerationBranch {
  readonly plan: PasswordPlan;
  readonly table: CountTable;
  readonly first?: PasswordType | undefined;
  readonly weight: bigint;
}
interface GenerationSpace {
  readonly branches: readonly GenerationBranch[];
  readonly total: bigint;
}
function generationSpace(plan: PasswordPlan): GenerationSpace {
  const candidates: Array<{ plan: PasswordPlan; first?: PasswordType }> = [];
  if (!plan.dontStartWithSymbol) candidates.push({ plan });
  else {
    for (let index = 0; index < plan.types.length; index += 1) {
      const first = plan.types[index] as PasswordType;
      if (first.name === "symbols" || first.max < 1) continue;
      const types = plan.types.map((type, i) => ({
        ...type,
        min: i === index ? Math.max(0, type.min - 1) : type.min,
        max: Math.min(plan.length - 1, type.max - (i === index ? 1 : 0)),
      }));
      candidates.push({ first, plan: { length: plan.length - 1, pool: plan.pool, types } });
    }
  }
  let total = 0n;
  const branches = candidates.map(({ plan: suffix, first }) => {
    const table = countTable(suffix);
    const suffixCount = (table.layers[table.types.length] as bigint[])[suffix.length] as bigint;
    const weight = suffixCount * BigInt(first?.characters.length ?? 1);
    total += weight;
    return { plan: suffix, table, first, weight };
  });
  return { branches, total };
}
function generateFromSpace(space: GenerationSpace, source: RandomSource): string {
  if (space.total < 1n) throw new PasswordError("no passwords satisfy the plan");
  // Preserve the original draw path when the rule is off or skipped.
  if (space.branches.length === 1 && !space.branches[0]?.first) {
    const branch = space.branches[0] as GenerationBranch;
    return generateFromTable(branch.plan, branch.table, source);
  }
  let target = randomBigInt(space.total, source);
  for (const branch of space.branches) {
    if (target < branch.weight)
      return (
        pick((branch.first as PasswordType).characters, source) + generateFromTable(branch.plan, branch.table, source)
      );
    target -= branch.weight;
  }
  throw new PasswordError("the count table is inconsistent");
}

/**
 * One count vector from the table, with probability proportional to the
 * number of valid passwords that have it. Taking the table's types from
 * last to first, with n positions still unassigned (L at the start), the
 * count c of the current type is chosen with weight
 * layers[k-1][n-c] * C(n, c) * size_k^c among c from min_k to min(max_k, n);
 * these weights sum to layers[k][n], the table entry, which is checked.
 * The product of the step probabilities telescopes to W(c) / layers[T][L]:
 * the probability the module header requires. Returned in plan order.
 */
function drawCounts(table: CountTable, source: RandomSource): number[] {
  const counts = new Array<number>(table.types.length).fill(0);
  let remaining = table.length;
  for (let k = table.types.length; k >= 1; k -= 1) {
    const type = table.types[k - 1] as TableType;
    const previous = table.layers[k - 1] as readonly bigint[];
    const expected = (table.layers[k] as readonly bigint[])[remaining] as bigint;
    const high = Math.min(type.max, remaining);
    const weights: bigint[] = [];
    let total = 0n;
    for (let c = type.min; c <= high; c += 1) {
      const weight = (previous[remaining - c] as bigint) * joinWeight(type, remaining, c);
      weights.push(weight);
      total += weight;
    }
    if (total < 1n || total !== expected) throw new PasswordError("the count table is inconsistent");
    const target = randomBigInt(total, source);
    let cumulative = 0n;
    let chosen = -1;
    for (let i = 0; i < weights.length; i += 1) {
      cumulative += weights[i] as bigint;
      if (target < cumulative) {
        chosen = type.min + i;
        break;
      }
    }
    if (chosen < 0) throw new PasswordError("the count table is inconsistent");
    counts[type.index] = chosen;
    remaining -= chosen;
  }
  if (remaining !== 0) throw new PasswordError("the count table is inconsistent");
  return counts;
}

/**
 * One password from a plan and its table: a count vector drawn in
 * proportion to the valid passwords that have it, the type labels shuffled
 * into a uniformly random order, and each position filled by a uniform pick
 * from its type (see the module header).
 */
function generateFromTable(plan: PasswordPlan, table: CountTable, source: RandomSource): string {
  const counts = drawCounts(table, source);
  const labels: number[] = [];
  counts.forEach((count, index) => {
    for (let i = 0; i < count; i += 1) labels.push(index);
  });
  const order = shuffle(labels, source);
  const characters = new Array<string>(plan.length);
  for (let position = 0; position < plan.length; position += 1) {
    const type = plan.types[order[position] as number] as PasswordType;
    characters[position] = pick(type.characters, source);
  }
  return characters.join("");
}

/**
 * One password for `options` under `config` (R6 to R11, R11a, R11b, R7a).
 *
 * @throws {LengthOutOfRangeError} {SymbolRuleError} {NoTypesSelectedError} {CountRangeError}
 *   {MinAboveMaxError} {LengthBelowTypesError} for a request that breaks a rule; see
 *   `planPassword`. No randomness is drawn.
 * @throws {RandomUnavailableError} if Web Crypto is missing or fails (S1).
 */
export function generatePassword(
  options: PasswordOptions,
  config: PasswordConfig,
  source: RandomSource = webCrypto,
): string {
  const plan = planPassword(options, config);
  return generateFromSpace(generationSpace(plan), source);
}

/**
 * `count` independent passwords for the same request, for the main result and
 * the extra results of R20 (the interface passes `config.extraResults`, which
 * lives outside the password section). Each password is generated exactly as
 * `generatePassword` would, from fresh draws; only the count tables, which are
 * plain arithmetic on the plan, are shared. If any one of them fails, the
 * whole call throws and nothing is returned.
 *
 * @throws {PasswordError} if `count` is not a non-negative integer, before any randomness is drawn.
 */
export function generatePasswords(
  options: PasswordOptions,
  config: PasswordConfig,
  count: number,
  source: RandomSource = webCrypto,
): string[] {
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new PasswordError("count must be a non-negative integer");
  }
  const plan = planPassword(options, config);
  const space = generationSpace(plan);
  const passwords: string[] = [];
  for (let i = 0; i < count; i += 1) passwords.push(generateFromSpace(space, source));
  return passwords;
}
