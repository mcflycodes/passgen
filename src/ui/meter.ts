import { config } from "../config/validate.ts";
import { EntropyError, passphraseBits, passwordBits } from "../core/entropy.ts";
import {
  BCRYPT_BITS,
  BCRYPT_BYTES,
  bcryptPassphraseBits,
  bcryptPassphrasePrefixBits,
  bcryptPasswordBits,
  bcryptPasswordPrefixBits,
  digestBits,
  NTLM_BITS,
  passphraseMaxBytes,
} from "../core/hash-entropy.ts";
import {
  EmptyWordlistError,
  filteredWordCount,
  type PassphraseOptions,
  PassphraseOptionsError,
} from "../core/passphrase.ts";
import { PasswordError, type PasswordPlan } from "../core/password.ts";
import { byId } from "./dom.ts";
import { reserveText } from "./reserved-text.ts";

export type MeterInput =
  | { readonly kind: "password"; readonly plan: PasswordPlan }
  | { readonly kind: "passphrase"; readonly options: PassphraseOptions };

export interface Meter {
  update(input: MeterInput | null, error?: unknown): void;
}

export function meterError(error: unknown): string {
  if (error instanceof EmptyWordlistError) return "No words remain. Widen the word-length range.";
  if (error instanceof PassphraseOptionsError || error instanceof PasswordError)
    return "Invalid settings. Adjust the settings to rate strength.";
  if (error instanceof EntropyError) return "Impossible settings. No valid results are available.";
  return "Strength unavailable. No result can be rated.";
}

export type MeterReading = { bits: number; warning: string } | { error: string };

/** Catch core errors at the seam: invalid settings must never retain an old rating. */
export function bitsFor(input: MeterInput): MeterReading {
  try {
    const bits = input.kind === "password" ? passwordBits(input.plan) : passphraseBits(input.options);
    if (!Number.isFinite(bits) || bits < 0) throw new EntropyError();
    let warning = "";
    if (input.kind === "passphrase" && bits < config.meter.passphraseWarningBits) {
      const count = filteredWordCount(input.options);
      const range = config.passphrase.wordLists.offered.find((list) => list.id === input.options.wordList);
      if (!range) throw new PassphraseOptionsError("Unavailable word list");
      const defaultCount = filteredWordCount({
        ...input.options,
        minWordLength: range.defaultMin,
        maxWordLength: range.defaultMax,
      });
      const numberSuggestion = input.options.number ? "" : " or turn on number separators";
      warning =
        count < defaultCount
          ? `This word-length range shrinks the pool to ${count.toLocaleString("en-US")} words and provides less than ${config.meter.passphraseWarningBits} bits with these settings. Widen the range${input.options.number ? " or" : ","} add words${numberSuggestion}.`
          : `These settings provide less than ${config.meter.passphraseWarningBits} bits. Add words${numberSuggestion}.`;
    }
    return { bits, warning };
  } catch (error) {
    return { error: meterError(error) };
  }
}

function validBits(bits: number): void {
  if (!Number.isFinite(bits) || bits < 0) throw new RangeError("Bits must be finite and non-negative");
}

export function bandFor(bits: number): { level: number; label: string } {
  validBits(bits);
  let level = 0;
  for (const [index, band] of config.meter.bands.entries()) if (bits >= band.minBits) level = index;
  return { level, label: config.meter.bands[level]?.label ?? "" };
}

const units = [
  [1, "second"],
  [60, "minute"],
  [3600, "hour"],
  [86400, "day"],
  [31557600, "year"],
] as const;
const LOG10_2 = Math.LOG10E * Math.LN2;

/** Logarithmic duration, so even keyspaces beyond Number's range stay readable. */
export function formatLogSeconds(logSeconds: number): string {
  if (!Number.isFinite(logSeconds)) throw new RangeError("Duration logarithm must be finite");
  if (logSeconds < -1e-12) return "Less than 1 second";
  let selected: (typeof units)[number] = units[0];
  for (const unit of units) if (logSeconds + 1e-12 >= Math.log10(unit[0])) selected = unit;
  for (const next of units) {
    if (next[0] <= selected[0]) continue;
    const rounded = Number((10 ** (logSeconds - Math.log10(selected[0]))).toPrecision(2));
    if (rounded >= next[0] / selected[0]) selected = next;
  }
  const magnitude = logSeconds - Math.log10(selected[0]);
  if (magnitude >= 6 || Number((10 ** magnitude).toPrecision(2)) >= 1e6) {
    let exponent = Math.floor(magnitude);
    let mantissa = Number((10 ** (magnitude - exponent)).toPrecision(2));
    if (mantissa >= 10) {
      mantissa = 1;
      exponent++;
    }
    return `${mantissa} × 10^${exponent} years`;
  }
  const value = Math.max(1, Number((10 ** magnitude).toPrecision(2)));
  return `${value.toLocaleString("en-US")} ${selected[1]}${value === 1 ? "" : "s"}`;
}

/** Display precision cannot imply that a band threshold has been reached. */
export function formatBits(bits: number): string {
  validBits(bits);
  return `${(Math.floor(bits * 10) / 10).toFixed(1)} bits`;
}

export function futureEstimate(bits: number, hypothetical = config.meter.quantum.future): string {
  validBits(bits);
  const logSeconds =
    Math.log10(Math.PI / 4) +
    Math.log10(hypothetical.iterationSeconds) +
    ((bits - Math.log2(hypothetical.processors)) * LOG10_2) / 2;
  return `Hypothetical future fault-tolerant quantum estimate: ${formatLogSeconds(logSeconds)}. ${hypothetical.assumptions}; ${hypothetical.processors} processors; (π/4) × sqrt(keyspace/processors) sequential iterations. This is a model, not demonstrated hardware performance.`;
}

export function crackTime(bits: number, guessesPerSecond: number): string {
  validBits(bits);
  if (!Number.isFinite(guessesPerSecond) || guessesPerSecond <= 0) throw new RangeError("Rate must be positive");
  return formatLogSeconds(
    bits * LOG10_2 + Math.log10(config.meter.attacks.fast.averageKeyspaceFraction) - Math.log10(guessesPerSecond),
  );
}

/** Distinct guesses against a uniform space, capped at certainty. No time model. */
export function onlineSuccessLog2(bits: number, attempts: number): number {
  validBits(bits);
  if (!Number.isSafeInteger(attempts) || attempts <= 0) throw new RangeError("Attempts must be a positive integer");
  return Math.min(0, Math.log2(attempts) - bits);
}

export function onlineChance(bits: number, attempts: number): string {
  const exponent = onlineSuccessLog2(bits, attempts) * LOG10_2 + 2;
  if (exponent >= -2) return `${Number((10 ** exponent).toPrecision(2))}%`;
  let power = Math.floor(exponent);
  let mantissa = Number((10 ** (exponent - power)).toPrecision(2));
  if (mantissa >= 10) {
    mantissa = 1;
    power++;
  }
  return `${mantissa} × 10^${power}%`;
}

export function createMeter(prefix: "pw" | "pp"): Meter {
  const section = byId(`${prefix}-meter`, HTMLElement);
  const band = byId(`${prefix}-band`, HTMLElement);
  const bits = byId(`${prefix}-bits`, HTMLElement);
  const headline = byId(`${prefix}-headline`, HTMLElement);
  const warning = byId(`${prefix}-meter-warning`, HTMLElement);
  const scenarios = byId(`${prefix}-scenarios`, HTMLElement);
  const quantum = byId(`${prefix}-quantum`, HTMLElement);
  const future = byId(`${prefix}-future`, HTMLElement);
  const announcement = byId(`${prefix}-meter-status`, HTMLElement);
  // Conservative display exemplars reserve space at the actual font and width,
  // including when details are open. These are sizing text, never estimates.
  const duration = "888,888 × 10^888 years";
  const attacks = config.meter.attacks;
  const fastAssumptions = `${attacks.fast.gpus} high-end GPUs, ${attacks.fast.hash}, ${attacks.fast.guessesPerSecond.toLocaleString("en-US")} guesses/second; half the keyspace on average.`;
  const capNote = ` NTLM search capped at its ${NTLM_BITS}-bit digest.`;
  reserveText(band, ["Invalid settings. Adjust the settings to rate strength."]);
  reserveText(headline, [`Average offline crack time (NTLM): ${duration}.`]);
  reserveText(scenarios, [
    `bcrypt cost ${attacks.bcrypt.cost}: ${duration} on average; ${attacks.bcrypt.guessesPerSecond.toLocaleString("en-US")} guesses/second across ${attacks.bcrypt.gpus} GPUs (extrapolated). bcrypt uses the first 72 bytes; conservative prefix entropy bound. bcrypt search capped at its ${BCRYPT_BITS}-bit digest.`,
    `Argon2id (${attacks.argon2id.parameters}): ${duration} on average; ${attacks.argon2id.guessesPerSecond.toLocaleString("en-US")} guesses/second across ${attacks.argon2id.gpus} GPUs (ideal scaling). Argon2id search capped at its ${8 * attacks.argon2id.tagBytes}-bit digest.`,
    `Online chance of success: 8.8 × 10^-888% with ${attacks.online.attempts} distinct guesses. Assumed lockout: ${attacks.online.lockout}.`,
    `${fastAssumptions}${capNote}`,
    "Estimates assume the attacker knows the generator's settings and wordlist. Hash rates and real attack conditions vary.",
  ]);
  if (prefix === "pw") {
    reserveText(byId("pw-notice", HTMLElement), [
      "Don't start with a symbol is skipped: these settings require only symbols.",
    ]);
  }
  if (prefix === "pp") {
    reserveText(warning, [
      `This word-length range shrinks the pool to 88,888 words and provides less than ${config.meter.passphraseWarningBits} bits with these settings. Widen the range, add words or turn on number separators.`,
    ]);
    reserveText(byId("pp-unique-note", HTMLElement), [
      "All symbols are used before repeating; repeats are spread evenly.",
    ]);
  }
  if (config.meter.quantum.future.enabled) {
    reserveText(future, [
      `Hypothetical future fault-tolerant quantum estimate: ${duration}. ${config.meter.quantum.future.assumptions}; ${config.meter.quantum.future.processors} processors; (π/4) × sqrt(keyspace/processors) sequential iterations. This is a model, not demonstrated hardware performance. Target: NTLM.${capNote}`,
    ]);
  }
  quantum.textContent = config.meter.quantum.current;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const announce = (message: string) => {
    clearTimeout(timer);
    announcement.textContent = "";
    timer = setTimeout(() => {
      announcement.textContent = message;
    }, 500);
  };
  return {
    update(input, error) {
      const reading = input === null ? { error: meterError(error) } : bitsFor(input);
      section.dataset.level = "";
      bits.textContent = "";
      headline.textContent = "";
      warning.textContent = "";
      warning.hidden = true;
      scenarios.replaceChildren();
      future.textContent = "";
      future.hidden = true;
      if ("error" in reading) {
        band.textContent = reading.error;
        announce(reading.error);
        return;
      }
      const rating = bandFor(reading.bits);
      section.dataset.level = String(rating.level);
      band.textContent = rating.label;
      bits.textContent = formatBits(reading.bits);
      warning.textContent = reading.warning;
      warning.hidden = !reading.warning;
      if (input === null) return;
      const fastBits = digestBits(reading.bits);
      const fastNote = reading.bits > NTLM_BITS ? capNote : "";
      const bcryptBits =
        input.kind === "password" ? bcryptPasswordBits(input.plan) : bcryptPassphraseBits(input.options);
      const truncated =
        input.kind === "password" ? input.plan.length > BCRYPT_BYTES : passphraseMaxBytes(input.options) > BCRYPT_BYTES;
      const bcryptPrefixBits =
        input.kind === "password" ? bcryptPasswordPrefixBits(input.plan) : bcryptPassphrasePrefixBits(input.options);
      const bcryptNote =
        (truncated ? " bcrypt uses the first 72 bytes; conservative prefix entropy bound." : "") +
        (bcryptPrefixBits > BCRYPT_BITS ? ` bcrypt search capped at its ${BCRYPT_BITS}-bit digest.` : "");
      const argon2idDigestBits = 8 * attacks.argon2id.tagBytes;
      const argon2idBits = digestBits(reading.bits, argon2idDigestBits);
      const argon2idNote =
        reading.bits > argon2idDigestBits ? ` Argon2id search capped at its ${argon2idDigestBits}-bit digest.` : "";
      headline.textContent = `Average offline crack time (NTLM): ${crackTime(fastBits, attacks.fast.guessesPerSecond)}.`;
      const lines = [
        `bcrypt cost ${attacks.bcrypt.cost}: ${crackTime(bcryptBits, attacks.bcrypt.guessesPerSecond)} on average; ${attacks.bcrypt.guessesPerSecond.toLocaleString("en-US")} guesses/second across ${attacks.bcrypt.gpus} GPUs (extrapolated).${bcryptNote}`,
        `Argon2id (${attacks.argon2id.parameters}): ${crackTime(argon2idBits, attacks.argon2id.guessesPerSecond)} on average; ${attacks.argon2id.guessesPerSecond.toLocaleString("en-US")} guesses/second across ${attacks.argon2id.gpus} GPUs (ideal scaling).${argon2idNote}`,
        `Online chance of success: ${onlineChance(reading.bits, attacks.online.attempts)} with ${attacks.online.attempts} distinct guesses. Assumed lockout: ${attacks.online.lockout}.`,
        `${fastAssumptions}${fastNote}`,
        "Estimates assume the attacker knows the generator's settings and wordlist. Hash rates and real attack conditions vary.",
      ];
      for (const line of lines) {
        const paragraph = document.createElement("p");
        paragraph.textContent = line;
        scenarios.append(paragraph);
      }
      const hypothetical = config.meter.quantum.future;
      if (hypothetical.enabled) {
        future.textContent = `${futureEstimate(fastBits, hypothetical)} Target: NTLM.${fastNote}`;
        future.hidden = false;
      }
      announce(
        `New ${prefix === "pw" ? "password" : "passphrase"} generated. ${rating.label}, ${bits.textContent}.${fastNote} ${reading.warning}`,
      );
    },
  };
}
