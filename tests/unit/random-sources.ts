// Deterministic and instrumented random sources for the randomness tests.
// Test-only: production code uses `webCrypto` from src/core/random.ts.

import type { RandomSource } from "../../src/core/random.ts";

/** Smallest 32-bit word whose top `bits` bits equal `value`, i.e. `value << (32 - bits)`. */
export function topBits(value: number, bits: number): number {
  return (value * 2 ** (32 - bits)) >>> 0;
}

/**
 * A source that hands out the given 32-bit words in order, one per element
 * requested, and throws once they run out. `consumed` counts the words taken,
 * so a test can prove exactly how many draws a call made.
 */
export function wordsSource(words: readonly number[]): RandomSource & { readonly consumed: number } {
  let index = 0;
  const source = (out: Uint32Array) => {
    for (let i = 0; i < out.length; i += 1) {
      const word = words[index];
      if (word === undefined) throw new Error(`wordsSource: exhausted after ${index} words`);
      out[i] = word;
      index += 1;
    }
  };
  Object.defineProperty(source, "consumed", { get: () => index, enumerable: true });
  return source as RandomSource & { readonly consumed: number };
}

/** A source that fails the test if it is ever called. */
export const neverSource: RandomSource = () => {
  throw new Error("neverSource: randomness was consumed where none was expected");
};

/** Wraps a source and counts the words it hands out. */
export function counting(inner: RandomSource): RandomSource & { readonly consumed: number } {
  let count = 0;
  const source = (out: Uint32Array) => {
    inner(out);
    count += out.length;
  };
  Object.defineProperty(source, "consumed", { get: () => count, enumerable: true });
  return source as RandomSource & { readonly consumed: number };
}

/**
 * Web Crypto, fetched `size` words at a time and handed out one by one. Same
 * randomness as `webCrypto`, far fewer calls: in Node each getRandomValues
 * call costs about 10 microseconds regardless of length, which would make
 * the million-draw statistical tests take tens of seconds. Test-only.
 */
export function bufferedWebCrypto(inner: RandomSource, size = 1024): RandomSource {
  const pool = new Uint32Array(size);
  let next = size;
  return (out: Uint32Array) => {
    for (let i = 0; i < out.length; i += 1) {
      if (next === size) {
        inner(pool);
        next = 0;
      }
      out[i] = pool[next] as number;
      next += 1;
    }
  };
}
