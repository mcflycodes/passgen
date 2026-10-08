import { config } from "../config/validate.ts";
import {
  defaultPassphraseOptions,
  EmptyWordlistError,
  filteredWordCount,
  type PassphraseOptions,
} from "./passphrase.ts";
import {
  countPasswords,
  defaultOptions,
  type PasswordConfig,
  type PasswordOptions,
  type PasswordPlan,
  planPassword,
} from "./password.ts";

export interface Entropy {
  readonly count: bigint;
  readonly bits: number;
}

/** A non-positive space has no available entropy estimate. */
export class EntropyError extends RangeError {
  override readonly name = "EntropyError";
}

/**
 * log2 of a positive exact integer, without converting the whole integer
 * to Number. Retain its leading 53 bits (exactly representable) and add
 * the discarded binary exponent. Truncation changes the logarithm by less
 * than log2(1 + 2^-52), well below 0.01 bits even beyond Number's range.
 */
export function log2BigInt(count: bigint): number {
  if (typeof count !== "bigint" || count <= 0n)
    throw new EntropyError("The possibility count must be a positive BigInt");
  const shift = Math.max(0, count.toString(2).length - 53);
  return Math.log2(Number(count >> BigInt(shift))) + shift;
}

/** Exact uniform password space, including the planner's effective Min/Max limits. */
export function passwordEntropy(
  options: PasswordOptions = defaultOptions(config.password),
  passwordConfig: PasswordConfig = config.password,
): Entropy {
  const count = countPasswords(planPassword(options, passwordConfig));
  return { count, bits: log2BigInt(count) };
}

/**
 * Independent word picks with replacement: W^w. Each of the w-1 number
 * separators has 10^d possibilities (including leading zeroes). The known
 * fixed symbol adds none. Random first-letter case adds 2^w when enabled.
 * Uses settings alone; no result or randomness is read.
 */
export function passphraseEntropy(options: PassphraseOptions = defaultPassphraseOptions): Entropy {
  const words = filteredWordCount(options); // Also validates all options, exactly as generation does.
  if (words === 0) throw new EmptyWordlistError("No words remain in the selected length range");
  const wordSpace = BigInt(words) ** BigInt(options.words);
  const numberSpace = options.number
    ? 10n ** BigInt(config.passphrase.separator.numberDigits * (options.words - 1))
    : 1n;
  const caseSpace = options.capitalize ? 2n ** BigInt(options.words) : 1n;
  const count = wordSpace * numberSpace * caseSpace;
  return { count, bits: log2BigInt(count) };
}

/** Meter seam: the generator's validated plan already contains the effective settings. */
export function passwordBits(plan: PasswordPlan): number {
  return log2BigInt(countPasswords(plan));
}

/** Meter seam: reuse the same settings-only passphrase calculation. */
export function passphraseBits(options: PassphraseOptions): number {
  return passphraseEntropy(options).bits;
}
