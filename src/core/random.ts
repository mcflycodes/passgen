// Unbiased random selection on Web Crypto (requirements S1 and S2).
//
// Every random value in PassGen comes through this module, and this module
// takes its randomness from one place: a `RandomSource`, which in production
// is `crypto.getRandomValues`. Nothing here, and nothing that depends on it,
// may use the language's built-in pseudo-random generator or anything derived
// from it (S1); tests/unit/no-math-random.test.ts enforces that for all of src/.
//
// Rules this module enforces:
//
// - Fail closed. If Web Crypto is missing or fails, `RandomUnavailableError` is
//   thrown and no value is returned. There is no fallback source.
// - Every call draws. Each exported function obtains at least one word from
//   the source on every call, even when the result is forced: a range of one
//   value, a collection of one element, a shuffle of fewer than two elements.
//   The word is discarded, which changes no distribution, but a missing or
//   broken source fails at the moment of use instead of silently succeeding
//   whenever there happens to be only one choice. A generator with a
//   one-character class, or a one-word pool, therefore produces nothing
//   without Web Crypto, like every other configuration.
// - No modulo. A uniform integer in [0, n) is drawn by taking just enough
//   random bits to cover n and rejecting any value that is n or more, then
//   drawing again. The modulo operator does not appear in the sampler.
// - One primitive. `pick` and `shuffle` (Fisher-Yates) are built on
//   `randomInt`, so they inherit its guarantees. `randomBigInt` is the same
//   scheme at any width, for the exact weighted draws of the password
//   generator, and draws its words from the source the same way.
//
// Trust boundary (decision 0006). Web Crypto's generator is trusted: it is the
// one thing this module cannot check. A `getRandomValues` that has been
// replaced, wrapped or broken, by an extension, injected script or a
// compromised browser, returns whatever it likes, and this module will turn
// that into deterministic or attacker-chosen output without noticing. No
// run-time test can tell a weak source from a strong one with the words it
// returns: zero words, repeated words and counters are all values a correct
// generator produces with some probability, so none is rejected. The threat
// model places a compromised browser or Web Crypto out of scope, and the
// Content Security Policy keeps injected script out of the page in the first
// place. tests/unit/random.test.ts demonstrates the behaviour on purpose.
//
// The module is DOM-free and runs unchanged in a browser and in Node's test
// runner. Tests inject a deterministic `RandomSource`; production code never
// passes one and gets Web Crypto.

/**
 * Fills `out` with cryptographically secure random 32-bit words. Must fill
 * every element, or throw. This is `crypto.getRandomValues` restricted to
 * `Uint32Array`; tests substitute a deterministic function.
 */
export type RandomSource = (out: Uint32Array) => void;

/** Web Crypto is missing, incomplete or failed. Nothing was generated. */
export class RandomUnavailableError extends Error {
  override readonly name = "RandomUnavailableError";
}

/** The requested range or input is invalid. Nothing was generated and no randomness was consumed. */
export class RandomRangeError extends RangeError {
  override readonly name = "RandomRangeError";
}

/** The largest `n` that `randomInt` accepts: one 32-bit word covers [0, 2^32) exactly. */
export const MAX_RANDOM_INT = 2 ** 32;

/** The part of Web Crypto this module uses. */
type CryptoLike = { getRandomValues: (array: Uint32Array) => unknown };

/**
 * Makes a `RandomSource` over a Web Crypto object, normally `globalThis.crypto`.
 * The object is checked at each call, so one that is missing, incomplete or
 * broken fails at the moment of use with `RandomUnavailableError`.
 */
export function webCryptoFrom(cryptoObject: unknown): RandomSource {
  return (out) => {
    const usable =
      typeof cryptoObject === "object" &&
      cryptoObject !== null &&
      typeof (cryptoObject as Partial<CryptoLike>).getRandomValues === "function";
    if (!usable) throw new RandomUnavailableError("Web Crypto (crypto.getRandomValues) is not available");
    try {
      (cryptoObject as CryptoLike).getRandomValues(out);
    } catch (cause) {
      throw new RandomUnavailableError("Web Crypto (crypto.getRandomValues) failed", { cause });
    }
  };
}

/**
 * The production source: this environment's Web Crypto, looked up as
 * `globalThis.crypto` at each call. That is the one reference to the global
 * object in shipped code, and the only form the no-Math.random check permits.
 */
export const webCrypto: RandomSource = (out) => webCryptoFrom(globalThis.crypto)(out);

/**
 * Number of bits needed to represent every value in [0, n), for 2 <= n <= 2^32.
 * 32 - clz32(n - 1) is the bit length of n - 1; for n = 2^32 that is 32.
 */
function bitsFor(n: number): number {
  return 32 - Math.clz32(n - 1);
}

/**
 * A uniformly distributed integer in [0, n), from `source`.
 *
 * Rejection sampling: a 32-bit word is drawn and its top `k` bits are kept,
 * where `k` is the smallest width with 2^k >= n. If that value is n or more
 * it is discarded and a fresh word is drawn. Every value that is kept had
 * exactly 2^-k probability, so the result is exactly uniform. Fewer than half
 * of all draws are rejected for any n, so the expected number of draws is
 * below 2; there is no upper bound on how many are consumed, as with any
 * rejection sampler.
 *
 * `n` must be an integer with 1 <= n <= 2^32 (`MAX_RANDOM_INT`), else
 * `RandomRangeError` is thrown before any randomness is drawn. For n = 1 the
 * only possible result is 0, but one word is still drawn and discarded so
 * that a missing or broken source fails even then (see "Every call draws").
 *
 * @throws {RandomRangeError} for an invalid `n`.
 * @throws {RandomUnavailableError} if the source is Web Crypto and it is missing or fails.
 */
export function randomInt(n: number, source: RandomSource = webCrypto): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_RANDOM_INT) {
    throw new RandomRangeError(`randomInt: n must be an integer from 1 to ${MAX_RANDOM_INT}, got ${String(n)}`);
  }
  const word = new Uint32Array(1);
  if (n === 1) {
    source(word);
    return 0;
  }
  const shift = 32 - bitsFor(n); // 0 for n > 2^31, up to 31 for n = 2
  for (;;) {
    source(word);
    // `>>>` is an unsigned shift: the result is the top `bitsFor(n)` bits of
    // the word, as a non-negative integer below 2^k. A shift of 0 keeps the
    // whole word, which for n = 2^32 is always in range.
    const candidate = (word[0] as number) >>> shift;
    if (candidate < n) return candidate;
  }
}

/**
 * A uniformly distributed BigInt in [0, n), from `source`, for any n >= 1.
 *
 * The same rejection scheme as `randomInt`, at any width: with `k` the
 * smallest width such that 2^k >= n (the bit length of n - 1), the smallest
 * number of 32-bit words that hold `k` bits is drawn from the source in one
 * call, the top word is shifted right so that exactly `k` bits remain, and
 * the words are joined into a candidate. The candidate is uniform over
 * [0, 2^k); if it is n or more it is discarded and fresh words are drawn, so
 * the result is exactly uniform over [0, n). More than half of all
 * candidates are accepted, so the expected number of draws is below 2; as
 * with `randomInt` there is no upper bound. The modulo operator does not
 * appear here either.
 *
 * `n` must be a BigInt with n >= 1, else `RandomRangeError` is thrown before
 * any randomness is drawn. For n = 1 the only possible result is 0, but one
 * word is still drawn and discarded, through `randomInt(1)`, so that a
 * missing or broken source fails even then (see "Every call draws"). For
 * n <= 2^32 it draws one word and makes the same decision from it as
 * `randomInt(Number(n))` would.
 *
 * @throws {RandomRangeError} for an invalid `n`.
 * @throws {RandomUnavailableError} if the source is Web Crypto and it is missing or fails.
 */
export function randomBigInt(n: bigint, source: RandomSource = webCrypto): bigint {
  if (typeof n !== "bigint" || n < 1n) {
    throw new RandomRangeError(`randomBigInt: n must be a BigInt of at least 1, got ${typeof n}`);
  }
  if (n === 1n) {
    randomInt(1, source);
    return 0n;
  }
  const bits = (n - 1n).toString(2).length; // 2^(bits-1) < n <= 2^bits, bits >= 1
  const words = new Uint32Array(Math.ceil(bits / 32));
  const shift = 32 * words.length - bits; // 0 to 31 bits dropped from the top word
  for (;;) {
    source(words);
    let candidate = BigInt((words[0] as number) >>> shift);
    for (let i = 1; i < words.length; i += 1) candidate = (candidate << 32n) | BigInt(words[i] as number);
    if (candidate < n) return candidate;
  }
}

/**
 * The elements of `items`. A string is split into Unicode code points
 * (`Array.from`), never into UTF-16 code units, so an element is always a
 * whole character such as "😀" and never a lone surrogate. Combining marks
 * remain separate code points; the character sets PassGen ships are ASCII
 * (R7), where none of this arises.
 */
function elements<T>(items: ArrayLike<T> | string): readonly T[] {
  if (typeof items === "string") return Array.from(items) as unknown as readonly T[];
  return Array.isArray(items) ? (items as readonly T[]) : Array.from(items);
}

/**
 * One element of `items`, each equally likely. A string is treated as its
 * sequence of code points (see `elements`), so `pick("A😀")` is "A" or "😀".
 *
 * @throws {RandomRangeError} if `items` is empty or has more than `MAX_RANDOM_INT` elements.
 */
export function pick(items: string, source?: RandomSource): string;
export function pick<T>(items: ArrayLike<T>, source?: RandomSource): T;
export function pick<T>(items: ArrayLike<T> | string, source: RandomSource = webCrypto): T {
  const list = elements<T>(items);
  if (list.length === 0) throw new RandomRangeError("pick: cannot pick from an empty collection");
  return list[randomInt(list.length, source)] as T;
}

/**
 * A new array with the elements of `items` in a uniformly random order,
 * by Fisher-Yates (Durstenfeld) using `randomInt` for every index. `items`
 * is not modified. Each of the length! orderings is equally likely. A string
 * is treated as its sequence of code points (see `elements`). Fewer than two
 * elements have only one ordering; one word is still drawn and discarded,
 * through `randomInt(1)`, so that a missing or broken source fails even then
 * (see "Every call draws").
 *
 * @throws {RandomUnavailableError} if the source is Web Crypto and it is missing or fails, for any length.
 */
export function shuffle(items: string, source?: RandomSource): string[];
export function shuffle<T>(items: ArrayLike<T>, source?: RandomSource): T[];
export function shuffle<T>(items: ArrayLike<T> | string, source: RandomSource = webCrypto): T[] {
  const out = Array.from(elements<T>(items));
  if (out.length < 2) randomInt(1, source);
  for (let i = out.length - 1; i >= 1; i -= 1) {
    const j = randomInt(i + 1, source);
    const moved = out[i] as T;
    out[i] = out[j] as T;
    out[j] = moved;
  }
  return out;
}
