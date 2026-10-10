// Hash limits affect offline searches, never the generator's displayed entropy.

import { log2BigInt, passphraseBits, passwordBits } from "./entropy.ts";
import { filteredWordCount, type PassphraseOptions } from "./passphrase.ts";
import { countPasswords, type PasswordPlan } from "./password.ts";
import { symbolSlots } from "./separators.ts";

export const BCRYPT_BYTES = 72;
export const NTLM_BITS = 128;
export const BCRYPT_BITS = 184;

export function digestBits(bits: number, digestSize = NTLM_BITS): number {
  return Math.min(bits, digestSize);
}

/**
 * Prefixes of constrained uniform passwords need not be uniform. For any
 * prefix, its number of completions is at most the count of suffixes with
 * relaxed minima and the original maxima. Thus max P(prefix) <= suffixes/N,
 * and log2(N/suffixes) is a conservative min-entropy bound. ASCII is one byte.
 * This is exact for a single unrestricted type. Counting distinct prefixes
 * instead would overstate resistance for nonuniform constrained prefixes.
 */
export function bcryptPasswordPrefixBits(plan: PasswordPlan): number {
  const bits = passwordBits(plan);
  if (plan.length <= BCRYPT_BYTES) return Math.min(bits, plan.length * Math.log2(plan.pool.length));
  const suffixLength = plan.length - BCRYPT_BYTES;
  const suffixes = countPasswords({
    ...plan,
    length: suffixLength,
    types: plan.types.map((type) => ({ ...type, min: 0, max: Math.min(type.max, suffixLength) })),
  });
  return Math.max(0, Math.min(bits, BCRYPT_BYTES * Math.log2(plan.pool.length), bits - log2BigInt(suffixes)));
}

export function passphraseMaxBytes(options: PassphraseOptions): number {
  const separator = (options.number ? options.numberDigits : 0) + symbolSlots(options);
  return options.words * options.maxWordLength + (options.words - 1) * separator;
}

/**
 * Count only independent picks guaranteed to fit within the first 72 ASCII
 * bytes, using the longest allowed word. Ignore partial words; count included
 * number digits individually. With no separator, a prefix may have several
 * word segmentations: the union bound charges one length-range factor per
 * complete word, so this remains conservative even for ambiguous boundaries.
 * Every word title case marks boundaries explicitly and needs no length penalty.
 * This settings-only lower bound also covers every extra result in the panel.
 */
export function bcryptPassphrasePrefixBits(options: PassphraseOptions): number {
  const bits = passphraseBits(options);
  if (passphraseMaxBytes(options) <= BCRYPT_BYTES) return bits;
  const words = filteredWordCount(options);
  let remaining = BCRYPT_BYTES;
  let prefixBits = 0;
  const ambiguous = !options.number && !options.symbol && options.capitalize !== "every";
  const wordBits = Math.max(
    0,
    Math.log2(words) +
      (options.capitalize === "random" ? 1 : 0) -
      (ambiguous ? Math.log2(options.maxWordLength - options.minWordLength + 1) : 0),
  );
  for (let index = 0; index < options.words; index++) {
    if (remaining < options.maxWordLength) break;
    remaining -= options.maxWordLength;
    prefixBits += wordBits;
    if (index === options.words - 1) break;
    if (options.symbol && (!options.number || options.symbolPosition !== "after")) {
      if (remaining === 0) break;
      remaining--;
    }
    if (options.number) {
      const digits = Math.min(remaining, options.numberDigits);
      prefixBits += digits * Math.log2(10);
      remaining -= digits;
      if (digits < options.numberDigits) break;
      if (options.symbol && options.symbolPosition !== "before") {
        if (remaining === 0) break;
        remaining--;
      }
    }
  }
  return Math.min(bits, prefixBits);
}

/** bcrypt stores a 184-bit hash, independent of its 72-byte input limit. */
export function bcryptPasswordBits(plan: PasswordPlan): number {
  return digestBits(bcryptPasswordPrefixBits(plan), BCRYPT_BITS);
}

export function bcryptPassphraseBits(options: PassphraseOptions): number {
  return digestBits(bcryptPassphrasePrefixBits(options), BCRYPT_BITS);
}
