// Unit tests for src/core/random.ts: the contract of each function, its edge
// cases, deterministic sources showing that rejection sampling runs and that
// the result is not `value % n`, and that every call draws from the source
// and fails closed without Web Crypto, even with only one possible result. Distribution tests with the real
// source are in random-stats.test.ts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MAX_RANDOM_INT,
  pick,
  RandomRangeError,
  type RandomSource,
  RandomUnavailableError,
  randomBigInt,
  randomInt,
  shuffle,
  webCrypto,
  webCryptoFrom,
} from "../../src/core/random.ts";
import { counting, neverSource, topBits, wordsSource } from "./random-sources.ts";

/**
 * Sources over a Web Crypto that is missing, incomplete, not a function, or
 * throws. Every exported function must throw `RandomUnavailableError` on each
 * of them, for every input, including inputs with only one possible result.
 */
function brokenSources(): Array<[string, RandomSource]> {
  return [
    ["undefined crypto", webCryptoFrom(undefined)],
    ["null crypto", webCryptoFrom(null)],
    ["crypto without getRandomValues", webCryptoFrom({})],
    ["getRandomValues that is not a function", webCryptoFrom({ getRandomValues: "yes" })],
    [
      "getRandomValues that throws",
      webCryptoFrom({
        getRandomValues() {
          throw new Error("broken");
        },
      }),
    ],
  ];
}

describe("webCryptoFrom: fail closed when Web Crypto is unavailable (S1)", () => {
  const cryptos: Array<[string, unknown]> = [
    ["an undefined crypto", undefined],
    ["a null crypto", null],
    ["a crypto without getRandomValues", {}],
    ["a getRandomValues that is not a function", { getRandomValues: "yes" }],
    ["a crypto that is a string", "crypto"],
  ];
  for (const [label, cryptoObject] of cryptos) {
    test(`throws RandomUnavailableError and returns nothing for ${label}`, () => {
      const source = webCryptoFrom(cryptoObject);
      assert.throws(() => randomInt(6, source), RandomUnavailableError);
      assert.throws(() => pick("abc", source), RandomUnavailableError);
      assert.throws(() => shuffle([1, 2, 3], source), RandomUnavailableError);
      assert.throws(() => randomBigInt(6n, source), RandomUnavailableError);
      assert.throws(() => randomBigInt(1n << 100n, source), RandomUnavailableError);
    });
  }

  test("wraps a failing getRandomValues in RandomUnavailableError with the cause attached", () => {
    const failure = new Error("quota");
    const source = webCryptoFrom({
      getRandomValues() {
        throw failure;
      },
    });
    assert.throws(
      () => randomInt(6, source),
      (error: unknown) => error instanceof RandomUnavailableError && error.cause === failure,
    );
  });

  test("is checked at call time, not import time, so a crypto that gains getRandomValues later works", () => {
    const cryptoObject: { getRandomValues?: (a: Uint32Array) => Uint32Array } = {};
    const source = webCryptoFrom(cryptoObject);
    assert.throws(() => randomInt(6, source), RandomUnavailableError);
    cryptoObject.getRandomValues = (a) => a.fill(0);
    assert.equal(randomInt(6, source), 0);
  });

  test("calls getRandomValues with crypto as `this` and the requested array", () => {
    let seenThis: unknown;
    let seenArray: unknown;
    const cryptoLike = {
      getRandomValues(this: unknown, array: Uint32Array) {
        seenThis = this;
        seenArray = array;
        return array.fill(0);
      },
    };
    randomInt(6, webCryptoFrom(cryptoLike));
    assert.equal(seenThis, cryptoLike);
    assert.ok(seenArray instanceof Uint32Array);
    assert.equal((seenArray as Uint32Array).length, 1);
  });

  test("the production default is this environment's Web Crypto and works", () => {
    const out = new Uint32Array(4);
    webCrypto(out);
    for (const word of out) assert.ok(Number.isInteger(word) && word >= 0 && word < 2 ** 32);
    const value = randomInt(10);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 10);
  });
});

describe("randomInt: argument validation (nothing drawn on a bad n)", () => {
  const invalid: Array<[string, unknown]> = [
    ["0", 0],
    ["a negative number", -1],
    ["a non-integer", 2.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["2^32 + 1 (one past the limit)", MAX_RANDOM_INT + 1],
    ["2^53", 2 ** 53],
    ["a numeric string", "6"],
    ["a bigint", 6n],
    ["undefined", undefined],
    ["null", null],
  ];
  for (const [label, n] of invalid) {
    test(`rejects ${label} with RandomRangeError`, () => {
      assert.throws(() => randomInt(n as number, neverSource), RandomRangeError);
      assert.throws(() => randomInt(n as number, neverSource), RangeError);
    });
  }

  test("MAX_RANDOM_INT is 2^32, the range one 32-bit word covers", () => {
    assert.equal(MAX_RANDOM_INT, 4294967296);
  });
});

describe("randomInt: edge cases of n", () => {
  test("n = 1 returns 0 but still draws exactly one word and discards it (every call draws)", () => {
    const source = wordsSource([0xdeadbeef]);
    assert.equal(randomInt(1, source), 0);
    assert.equal(source.consumed, 1);
    assert.equal(randomInt(1, wordsSource([0])), 0);
    assert.equal(randomInt(1, wordsSource([0xffffffff])), 0);
  });

  test("n = 1 fails closed: no result when the source is missing, not a function, or throws", () => {
    for (const [label, source] of brokenSources()) {
      assert.throws(() => randomInt(1, source), RandomUnavailableError, label);
    }
    assert.throws(() => randomInt(1, neverSource), /neverSource/);
  });

  test("n = 2 uses only the top bit of the word", () => {
    assert.equal(randomInt(2, wordsSource([0x7fffffff])), 0);
    assert.equal(randomInt(2, wordsSource([0x80000000])), 1);
  });

  test("n = 2^32 keeps the whole word, never rejects, and reaches both ends of the range", () => {
    const low = wordsSource([0]);
    assert.equal(randomInt(MAX_RANDOM_INT, low), 0);
    assert.equal(low.consumed, 1);
    const high = wordsSource([0xffffffff]);
    assert.equal(randomInt(MAX_RANDOM_INT, high), 4294967295);
    assert.equal(high.consumed, 1);
    const mid = wordsSource([0x80000000]);
    assert.equal(randomInt(MAX_RANDOM_INT, mid), 2147483648);
  });

  test("n = 2^32 - 1 rejects only the word 0xffffffff", () => {
    const source = wordsSource([0xffffffff, 0xfffffffe]);
    assert.equal(randomInt(MAX_RANDOM_INT - 1, source), 4294967294);
    assert.equal(source.consumed, 2);
  });

  test("n = 2^31 uses 31 bits: the bottom bit of the word is ignored", () => {
    assert.equal(randomInt(2 ** 31, wordsSource([0xffffffff])), 2 ** 31 - 1);
    assert.equal(randomInt(2 ** 31, wordsSource([0x00000001])), 0);
  });

  test("n = 2^31 + 1 uses all 32 bits and rejects anything at or above n", () => {
    const source = wordsSource([0xffffffff, 2 ** 31 + 1, 2 ** 31]);
    assert.equal(randomInt(2 ** 31 + 1, source), 2 ** 31);
    assert.equal(source.consumed, 3);
  });

  test("exact powers of two never reject", () => {
    for (const k of [1, 2, 3, 7, 8, 16, 31, 32]) {
      const n = 2 ** k;
      const source = counting(webCrypto);
      for (let i = 0; i < 200; i += 1) {
        const value = randomInt(n, source);
        assert.ok(value >= 0 && value < n);
      }
      assert.equal(source.consumed, 200, `n = 2^${k}`);
    }
  });
});

describe("randomInt: rejection sampling, not modulo (S2)", () => {
  test("n = 3 uses 2 bits; a candidate of 3 is discarded and the next word is drawn", () => {
    // Top two bits 0b11 = 3 >= n: rejected. Top two bits 0b10 = 2 < n: kept.
    const source = wordsSource([topBits(3, 2), topBits(2, 2)]);
    assert.equal(randomInt(3, source), 2);
    assert.equal(source.consumed, 2, "the rejected word costs one draw and the kept word another");
  });

  test("the result is the kept candidate, never (word % n)", () => {
    // Plain modulo would return 0xc0000000 % 3 === 0 from the first word and
    // consume one draw. Rejection sampling discards it and returns 2 from the second.
    const first = 0xc0000000;
    assert.equal(first % 3, 0);
    const source = wordsSource([first, topBits(2, 2)]);
    assert.equal(randomInt(3, source), 2);
    assert.equal(source.consumed, 2);
    // And for a kept word, the result is its top bits, not its remainder.
    const kept = 0x40000004; // top two bits 0b01, remainder 0x40000004 % 3 === 2
    assert.equal(kept % 3, 2);
    assert.equal(randomInt(3, wordsSource([kept])), 1);
  });

  test("keeps drawing until a candidate is in range, however many rejections", () => {
    const source = wordsSource([topBits(7, 3), topBits(6, 3), topBits(5, 3), topBits(7, 3), topBits(4, 3)]);
    assert.equal(randomInt(5, source), 4);
    assert.equal(source.consumed, 5);
  });

  test("for n = 5 the candidates 5, 6 and 7 are all rejected and 0 to 4 are all kept as they are", () => {
    for (let candidate = 0; candidate < 8; candidate += 1) {
      // Follow the candidate with an in-range word so a rejected draw can finish.
      const source = wordsSource([topBits(candidate, 3), topBits(0, 3)]);
      const value = randomInt(5, source);
      if (candidate < 5) {
        assert.equal(value, candidate);
        assert.equal(source.consumed, 1);
      } else {
        assert.equal(value, 0);
        assert.equal(source.consumed, 2);
      }
    }
  });

  test("over every k-bit prefix once, each value in [0, n) is produced exactly once (exactly uniform)", () => {
    for (const n of [3, 5, 6, 7, 10, 26, 62, 94, 100, 200]) {
      const bits = Math.ceil(Math.log2(n));
      const words: number[] = [];
      for (let candidate = 0; candidate < 2 ** bits; candidate += 1) words.push(topBits(candidate, bits));
      const source = wordsSource(words);
      const counts = new Array<number>(n).fill(0);
      // Each call consumes one word per candidate; rejected candidates produce no value.
      while (source.consumed < words.length) {
        try {
          const value = randomInt(n, source);
          counts[value] = (counts[value] ?? 0) + 1;
        } catch {
          break; // the final candidates were all rejected and the source ran dry
        }
      }
      assert.deepEqual(
        counts,
        new Array<number>(n).fill(1),
        `n = ${n}: every value once, the ${2 ** bits - n} out-of-range candidates discarded`,
      );
    }
  });

  test("ignores the low bits of the word for small n (only the top k bits matter)", () => {
    for (let noise = 0; noise < 0x3fffffff; noise += 0x01234567) {
      assert.equal(randomInt(3, wordsSource([(topBits(1, 2) | noise) >>> 0])), 1);
    }
  });

  test("with the real source, rejections do happen for a non-power-of-two n", () => {
    // n = 3 keeps 3 of 4 candidates. Over 10,000 calls the chance of zero
    // rejections is 0.75^10000, so more words than calls proves the branch runs.
    const source = counting(webCrypto);
    for (let i = 0; i < 10000; i += 1) randomInt(3, source);
    assert.ok(source.consumed > 10000);
    // and never more than a handful per call on average (expected 4/3 draws).
    assert.ok(source.consumed < 20000);
  });
});

describe("trust boundary: a replaced or broken getRandomValues is not detected (decision 0006)", () => {
  // Documented behaviour, demonstrated on purpose: the module trusts Web
  // Crypto and cannot tell a weak source from a strong one. Nothing here is a
  // defect to fix; a run-time health check cannot distinguish these outputs
  // from values a correct generator also produces.

  test("a getRandomValues that leaves the buffer at zero gives the same output every time, with no error", () => {
    const source = webCryptoFrom({ getRandomValues: (a: Uint32Array) => a });
    for (let i = 0; i < 20; i += 1) {
      assert.equal(randomInt(94, source), 0);
      assert.equal(pick("abc", source), "a");
      assert.deepEqual(shuffle([1, 2, 3, 4], source), [2, 3, 4, 1]);
    }
  });

  test("a getRandomValues that counts gives predictable output, with no error", () => {
    let counter = 0;
    const source = webCryptoFrom({
      getRandomValues(a: Uint32Array) {
        for (let i = 0; i < a.length; i += 1) {
          a[i] = topBits(counter, 7);
          counter = (counter + 1) & 0x7f;
        }
        return a;
      },
    });
    const first = Array.from({ length: 10 }, () => randomInt(94, source));
    counter = 0;
    const second = Array.from({ length: 10 }, () => randomInt(94, source));
    assert.deepEqual(first, second);
    assert.deepEqual(first, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("zero words are accepted as values, not rejected as suspicious", () => {
    // Zero is a legitimate result with probability 1/n; rejecting it would itself bias the output.
    assert.equal(randomInt(10, wordsSource([0])), 0);
    assert.equal(randomInt(MAX_RANDOM_INT, wordsSource([0])), 0);
  });
});

describe("pick", () => {
  test("rejects an empty array or string without drawing", () => {
    assert.throws(() => pick([], neverSource), RandomRangeError);
    assert.throws(() => pick("", neverSource), RandomRangeError);
  });

  test("picks the element at randomInt(length)", () => {
    const items = ["a", "b", "c", "d", "e"];
    for (let candidate = 0; candidate < 5; candidate += 1) {
      assert.equal(pick(items, wordsSource([topBits(candidate, 3)])), items[candidate]);
    }
  });

  test("works on a string as a character set", () => {
    assert.equal(pick("xyz", wordsSource([topBits(2, 2)])), "z");
  });

  test("treats a string as code points: never returns a lone surrogate", () => {
    // "A😀" is 3 UTF-16 code units but 2 code points, so n = 2 and one bit decides.
    assert.equal(pick("A😀", wordsSource([topBits(0, 1)])), "A");
    assert.equal(pick("A😀", wordsSource([topBits(1, 1)])), "😀");
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(pick("A😀"));
    assert.deepEqual([...seen].sort(), ["A", "😀"]);
  });

  test("a combining mark is its own code point", () => {
    // "e" followed by U+0301 is two code points; each is a possible result.
    assert.equal(pick("e\u0301", wordsSource([topBits(1, 1)])), "\u0301");
  });

  test("an array of strings is not split further", () => {
    assert.equal(pick(["ab", "😀😀"], wordsSource([topBits(1, 1)])), "😀😀");
  });

  test("a single-element collection returns that element after drawing exactly one word", () => {
    const array = wordsSource([0x12345678]);
    assert.equal(pick(["only"], array), "only");
    assert.equal(array.consumed, 1);
    const string = wordsSource([0]);
    assert.equal(pick("x", string), "x");
    assert.equal(string.consumed, 1);
  });

  test("a single-element collection fails closed: no result when the source is missing, not a function, or throws", () => {
    for (const [label, source] of brokenSources()) {
      assert.throws(() => pick(["only"], source), RandomUnavailableError, label);
      assert.throws(() => pick("x", source), RandomUnavailableError, label);
    }
    assert.throws(() => pick(["only"], neverSource), /neverSource/);
  });

  test("uses rejection like randomInt (an out-of-range candidate is discarded)", () => {
    const source = wordsSource([topBits(3, 2), topBits(0, 2)]);
    assert.equal(pick(["a", "b", "c"], source), "a");
    assert.equal(source.consumed, 2);
  });

  test("with the real source, every element is reachable", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(pick("abcdefghij"));
    assert.equal(seen.size, 10);
  });
});

describe("shuffle", () => {
  test("returns a new array and leaves the input untouched", () => {
    const input = [1, 2, 3, 4, 5];
    const copy = [...input];
    const out = shuffle(input);
    assert.notEqual(out, input);
    assert.deepEqual(input, copy);
    assert.deepEqual([...out].sort(), copy);
  });

  test("accepts any array-like, including a string, and returns an array", () => {
    const out = shuffle("abc", wordsSource([topBits(0, 2), topBits(0, 1)]));
    assert.deepEqual(out, ["b", "c", "a"]);
  });

  test("treats a string as code points, like pick", () => {
    const out = shuffle("a😀b", wordsSource([topBits(0, 2), topBits(0, 1)]));
    assert.deepEqual(out, ["😀", "b", "a"]);
    for (let i = 0; i < 100; i += 1) {
      assert.deepEqual([...shuffle("a😀b")].sort(), ["a", "b", "😀"]);
    }
  });

  test("accepts a typed array", () => {
    assert.deepEqual(shuffle(new Uint8Array([1, 2, 3]), wordsSource([topBits(0, 2), topBits(0, 1)])), [2, 3, 1]);
  });

  test("empty and single-element inputs draw exactly one word and discard it (every call draws)", () => {
    const empty = wordsSource([0xffffffff]);
    assert.deepEqual(shuffle([], empty), []);
    assert.equal(empty.consumed, 1);
    const one = wordsSource([0]);
    assert.deepEqual(shuffle([42], one), [42]);
    assert.equal(one.consumed, 1);
    const string = wordsSource([0x80000000]);
    assert.deepEqual(shuffle("z", string), ["z"]);
    assert.equal(string.consumed, 1);
  });

  test("empty and single-element inputs fail closed: no result when the source is missing, not a function, or throws", () => {
    for (const [label, source] of brokenSources()) {
      assert.throws(() => shuffle([], source), RandomUnavailableError, label);
      assert.throws(() => shuffle([42], source), RandomUnavailableError, label);
      assert.throws(() => shuffle("z", source), RandomUnavailableError, label);
    }
    assert.throws(() => shuffle([], neverSource), /neverSource/);
    assert.throws(() => shuffle([42], neverSource), /neverSource/);
  });

  test("two or more elements draw through randomInt as before, and fail closed the same way", () => {
    for (const [label, source] of brokenSources()) {
      assert.throws(() => shuffle([1, 2], source), RandomUnavailableError, label);
    }
  });

  test("is Fisher-Yates from the end: step i swaps position i with randomInt(i + 1)", () => {
    // Length 4: i = 3 draws from [0, 4) (2 bits), i = 2 from [0, 3) (2 bits), i = 1 from [0, 2) (1 bit).
    // Choose j = 0, 1, 1: [a,b,c,d] -> swap(3,0) [d,b,c,a] -> swap(2,1) [d,c,b,a] -> swap(1,1) [d,c,b,a].
    const source = wordsSource([topBits(0, 2), topBits(1, 2), topBits(1, 1)]);
    assert.deepEqual(shuffle(["a", "b", "c", "d"], source), ["d", "c", "b", "a"]);
    assert.equal(source.consumed, 3);
  });

  test("identity draws (j = i each step) leave the order unchanged", () => {
    const source = wordsSource([topBits(3, 2), topBits(2, 2), topBits(1, 1)]);
    assert.deepEqual(shuffle([1, 2, 3, 4], source), [1, 2, 3, 4]);
  });

  test("uses rejection at every step: an out-of-range candidate is discarded, not reduced", () => {
    // i = 2 draws from [0, 3) with 2 bits: candidate 3 is rejected.
    const source = wordsSource([topBits(0, 2), topBits(3, 2), topBits(1, 2), topBits(1, 1)]);
    assert.deepEqual(shuffle(["a", "b", "c", "d"], source), ["d", "c", "b", "a"]);
    assert.equal(source.consumed, 4);
  });

  test("every permutation of 3 elements is produced by some draw sequence", () => {
    // i = 2: j in {0,1,2} via 2 bits; i = 1: j in {0,1} via 1 bit. 3 * 2 = 6 permutations.
    const seen = new Set<string>();
    for (let j2 = 0; j2 < 3; j2 += 1) {
      for (let j1 = 0; j1 < 2; j1 += 1) {
        seen.add(shuffle([0, 1, 2], wordsSource([topBits(j2, 2), topBits(j1, 1)])).join(""));
      }
    }
    assert.equal(seen.size, 6);
  });

  test("with the real source, a shuffle of 128 elements is a permutation", () => {
    const input = Array.from({ length: 128 }, (_, i) => i);
    const out = shuffle(input);
    assert.deepEqual(
      [...out].sort((a, b) => a - b),
      input,
    );
  });
});

describe("randomBigInt: argument validation (nothing drawn on a bad n)", () => {
  const invalid: Array<[string, unknown]> = [
    ["0n", 0n],
    ["a negative BigInt", -1n],
    ["a number", 6],
    ["a numeric string", "6"],
    ["undefined", undefined],
    ["null", null],
  ];
  for (const [label, n] of invalid) {
    test(`rejects ${label} with RandomRangeError`, () => {
      assert.throws(() => randomBigInt(n as bigint, neverSource), RandomRangeError);
      assert.throws(() => randomBigInt(n as bigint, neverSource), RangeError);
    });
  }
});

describe("randomBigInt: rejection sampling at any width, not modulo (S2)", () => {
  test("n = 1 returns 0 but still draws exactly one word and discards it (every call draws)", () => {
    const source = wordsSource([0xdeadbeef]);
    assert.equal(randomBigInt(1n, source), 0n);
    assert.equal(source.consumed, 1);
    for (const [label, broken] of brokenSources()) {
      assert.throws(() => randomBigInt(1n, broken), RandomUnavailableError, label);
    }
    assert.throws(() => randomBigInt(1n, neverSource), /neverSource/);
  });

  test("n below 2^32 draws one word and keeps its top bits, exactly as randomInt does", () => {
    // n = 3: 2 bits. Candidate 3 is rejected and the next word is drawn.
    const source = wordsSource([topBits(3, 2), topBits(2, 2)]);
    assert.equal(randomBigInt(3n, source), 2n);
    assert.equal(source.consumed, 2);
    assert.equal(randomBigInt(2n, wordsSource([0x7fffffff])), 0n);
    assert.equal(randomBigInt(2n, wordsSource([0x80000000])), 1n);
    for (const n of [2, 3, 5, 94, 1000, 2 ** 31, 2 ** 31 + 1, 2 ** 32 - 1, 2 ** 32]) {
      for (const word of [0, 1, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) {
        // The same word gives the same decision and the same value as randomInt, or is rejected by both.
        const small = wordsSource([word, 0]);
        const big = wordsSource([word, 0]);
        assert.equal(randomBigInt(BigInt(n), big), BigInt(randomInt(n, small)), `n ${n}, word ${word}`);
        assert.equal(big.consumed, small.consumed, `n ${n}, word ${word}: same rejections`);
      }
    }
  });

  test("n = 2^32 + 1 uses 33 bits: the top word keeps one bit, the second is kept whole", () => {
    const n = (1n << 32n) + 1n;
    const low = wordsSource([0, 0]);
    assert.equal(randomBigInt(n, low), 0n);
    assert.equal(low.consumed, 2);
    // Top bit set and second word 0: candidate 2^32 < n, kept.
    assert.equal(randomBigInt(n, wordsSource([0x80000000, 0])), 1n << 32n);
    // Top bit set and second word 1: candidate 2^32 + 1 = n, rejected; then 2^32 - 1.
    const rejecting = wordsSource([0x80000000, 1, 0x7fffffff, 0xffffffff]);
    assert.equal(randomBigInt(n, rejecting), (1n << 32n) - 1n);
    assert.equal(rejecting.consumed, 4, "a rejected candidate costs all of its words");
    // Only the top bit of the first word counts: lower bits are dropped, not folded in.
    assert.equal(randomBigInt(n, wordsSource([0x7fffffff, 5])), 5n);
  });

  test("n = 2^64 keeps two whole words and never rejects; n = 2^64 - 1 rejects only all ones", () => {
    const full = wordsSource([0xffffffff, 0xffffffff]);
    assert.equal(randomBigInt(1n << 64n, full), (1n << 64n) - 1n);
    assert.equal(full.consumed, 2);
    assert.equal(randomBigInt(1n << 64n, wordsSource([1, 2])), (1n << 32n) + 2n);
    const almost = wordsSource([0xffffffff, 0xffffffff, 0xffffffff, 0xfffffffe]);
    assert.equal(randomBigInt((1n << 64n) - 1n, almost), (1n << 64n) - 2n);
    assert.equal(almost.consumed, 4);
  });

  test("n = 2^99 draws four words per candidate with 29 bits dropped from the top word, and never rejects", () => {
    const n = 1n << 99n; // n - 1 has 99 bits: 4 words, shift 29
    const source = wordsSource([0xffffffff, 0, 0, 1]);
    assert.equal(randomBigInt(n, source), (7n << 96n) + 1n);
    assert.equal(source.consumed, 4);
  });

  test("n = 2^99 + 1 uses 100 bits (shift 28): the candidate equal to n is rejected and all four words redrawn", () => {
    const n = (1n << 99n) + 1n;
    const rejecting = wordsSource([0x80000000, 0, 0, 1, 0x80000000, 0, 0, 0]);
    assert.equal(randomBigInt(n, rejecting), 1n << 99n);
    assert.equal(rejecting.consumed, 8);
  });

  test("with the real source the result is always in range, across widths from 2 to 900 bits", () => {
    for (const bits of [2, 5, 31, 32, 33, 63, 64, 65, 100, 500, 839, 900]) {
      const n = (1n << BigInt(bits)) - 1n;
      const source = counting(webCrypto);
      for (let i = 0; i < 20; i += 1) {
        const value = randomBigInt(n, source);
        assert.ok(value >= 0n && value < n, `${bits} bits`);
      }
      assert.ok(source.consumed >= 20 * Math.ceil(bits / 32), `${bits} bits: every call draws enough words`);
    }
    const value = randomBigInt(1000n);
    assert.ok(value >= 0n && value < 1000n, "the production default source works");
  });
});
