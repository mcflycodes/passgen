import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../../src/config/validate.ts";
import { EntropyError } from "../../src/core/entropy.ts";
import { defaultPassphraseOptions, EmptyWordlistError, PassphraseOptionsError } from "../../src/core/passphrase.ts";
import { defaultOptions, NoTypesSelectedError, planPassword } from "../../src/core/password.ts";
import {
  bandFor,
  bitsFor,
  crackTime,
  formatBits,
  formatLogSeconds,
  futureEstimate,
  meterError,
  onlineChance,
  onlineSuccessLog2,
} from "../../src/ui/meter.ts";

for (const [index, band] of config.meter.bands.entries()) {
  test(`band boundary ${band.minBits} maps to ${band.label}`, () => {
    assert.deepEqual(bandFor(band.minBits), { level: index, label: band.label });
    assert.equal(bandFor(band.minBits + 0.0001).level, index);
    if (index > 0) assert.equal(bandFor(band.minBits - 0.0001).level, index - 1);
  });
}

test("duration formatter covers tiny, exact unit boundaries and astronomical spaces", () => {
  assert.equal(formatLogSeconds(-300), "Less than 1 second");
  assert.equal(formatLogSeconds(0), "1 second");
  for (const [seconds, unit] of [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [31557600, "year"],
  ] as const) {
    assert.equal(formatLogSeconds(Math.log10(seconds)), `1 ${unit}`);
    assert.ok(!formatLogSeconds(Math.log10(seconds) - 0.03).includes(unit));
  }
  assert.equal(formatLogSeconds(Math.log10(31557600) + 6), "1 × 10^6 years");
  assert.equal(crackTime(1, 1), "1 second");
  assert.equal(crackTime(0, 2.4e12), "Less than 1 second");
  assert.match(crackTime(10000, 2.4e12), /× 10\^\d+ years/);
  for (const bits of [0, 130.93, 838.99, 10000]) assert.doesNotMatch(crackTime(bits, 2.4e12), /Infinity|NaN/);
  for (const bits of [-1, NaN, Infinity]) assert.throws(() => bandFor(bits), RangeError);
  assert.throws(() => crackTime(10, 0), RangeError);
  assert.throws(() => formatLogSeconds(Infinity), RangeError);
});

test("online chance is guesses / keyspace, capped at certainty, with no underflow", () => {
  assert.equal(onlineSuccessLog2(10, 100), Math.log2(100) - 10);
  assert.equal(onlineSuccessLog2(0, 100), 0);
  assert.equal(onlineChance(0, 100), "100%");
  assert.equal(onlineChance(10, 100), "9.8%");
  assert.equal(onlineChance(1, 1), "50%");
  assert.match(onlineChance(10000, 100), /× 10\^-\d+%/);
  assert.throws(() => onlineSuccessLog2(10, 0), RangeError);
});

test("meter uses core bits and warns below the configurable passphrase floor", () => {
  const password = bitsFor({ kind: "password", plan: planPassword(defaultOptions(config.password), config.password) });
  assert.ok("bits" in password && password.bits > 128 && password.warning === "");
  const phrase = bitsFor({ kind: "passphrase", options: defaultPassphraseOptions });
  assert.ok("bits" in phrase && Math.abs(phrase.bits - 90.67) < 0.01 && phrase.warning === "");
  const narrow = bitsFor({
    kind: "passphrase",
    options: { ...defaultPassphraseOptions, minWordLength: 3, maxWordLength: 3 },
  });
  assert.ok("bits" in narrow && narrow.bits < 80 && /shrinks the pool to \d+ words/.test(narrow.warning));
});

test("typed errors become clear states without retaining a numeric estimate", () => {
  assert.deepEqual(bitsFor({ kind: "passphrase", options: { ...defaultPassphraseOptions, words: 0 } }), {
    error: meterError(new PassphraseOptionsError()),
  });
  assert.deepEqual(
    bitsFor({
      kind: "password",
      plan: { length: 4, pool: ["a"], types: [{ name: "lowercase", characters: ["a"], min: 0, max: 0 }] },
    }),
    { error: meterError(new EntropyError()) },
  );
  assert.match(meterError(new EmptyWordlistError()), /No words remain/);
  assert.match(meterError(new NoTypesSelectedError()), /Invalid settings/);
  assert.match(meterError(new Error("secret")), /Strength unavailable/);
  assert.doesNotMatch(meterError(new Error("secret")), /secret/);
});

for (const [bits, text] of [
  [79.95, "79.9 bits"],
  [127.98, "127.9 bits"],
] as const)
  test(`display truncates ${bits} below its band boundary`, () => assert.equal(formatBits(bits), text));

for (const [seconds, text] of [
  [59.6, "1 minute"],
  [3599, "1 hour"],
  [86000, "1 day"],
  [365.06 * 86400, "1 year"],
  [999999.5 * 31557600, "1 × 10^6 years"],
] as const)
  test(`rounded duration promotes ${seconds} seconds`, () => assert.equal(formatLogSeconds(Math.log10(seconds)), text));

test("future estimate enabled config uses the research model and states its assumptions", () => {
  const future = { ...config.meter.quantum.future, enabled: true };
  const text = futureEstimate(128, future);
  assert.ok(future.enabled);
  assert.match(text, /6.9 × 10\^12 years/);
  assert.ok(text.includes(future.assumptions));
  assert.match(text, /Hypothetical future fault-tolerant/);
  assert.match(text, /1 processors/);
  assert.match(text, /not demonstrated hardware performance/);
  assert.doesNotMatch(text, /quantum[-\s]+(?:safe|proof)/i);
});

test("full default pool warning names weak settings instead of blaming the range", () => {
  for (const options of [
    { ...defaultPassphraseOptions, words: 2 },
    { ...defaultPassphraseOptions, number: false },
  ]) {
    const reading = bitsFor({ kind: "passphrase", options });
    assert.ok("bits" in reading);
    assert.equal(
      reading.warning,
      options.number
        ? "These settings provide less than 80 bits. Add words."
        : "These settings provide less than 80 bits. Add words or turn on number separators.",
    );
  }
});

for (const narrow of [false, true])
  for (const number of [false, true])
    test(`R13 advice with ${narrow ? "narrow" : "default"} pool and numbers ${number ? "on" : "off"}`, () => {
      const reading = bitsFor({
        kind: "passphrase",
        options: {
          ...defaultPassphraseOptions,
          words: 3,
          number,
          ...(narrow ? { minWordLength: 3, maxWordLength: 3 } : {}),
        },
      });
      assert.ok("bits" in reading && reading.bits < 80);
      const advice = number ? "Add words." : "Add words or turn on number separators.";
      assert.equal(
        reading.warning,
        narrow
          ? `This word-length range shrinks the pool to 82 words and provides less than 80 bits with these settings. Widen the range${number ? " or" : ","} ${advice.toLowerCase()}`
          : `These settings provide less than 80 bits. ${advice}`,
      );
    });
