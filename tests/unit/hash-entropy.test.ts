import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../../src/config/validate.ts";
import { passphraseBits, passwordBits } from "../../src/core/entropy.ts";
import {
  BCRYPT_BITS,
  bcryptPassphraseBits,
  bcryptPassphrasePrefixBits,
  bcryptPasswordBits,
  bcryptPasswordPrefixBits,
  digestBits,
  passphraseMaxBytes,
} from "../../src/core/hash-entropy.ts";
import { defaultPassphraseOptions, filteredWordCount } from "../../src/core/passphrase.ts";
import { defaultCounts, defaultOptions, planPassword } from "../../src/core/password.ts";

const lowercase = (length: number) =>
  planPassword(
    {
      ...defaultOptions(config.password),
      length,
      uppercase: false,
      numbers: false,
      simple: false,
      complex: false,
      counts: defaultCounts(config.password, length),
    },
    config.password,
  );

for (const length of [71, 72, 73, 128])
  test(`bcrypt lowercase boundary ${length} bytes`, () => {
    const plan = lowercase(length);
    assert.ok(Math.abs(bcryptPasswordBits(plan) - Math.min(Math.min(length, 72) * Math.log2(26), 184)) < 1e-10);
    assert.ok(bcryptPasswordBits(plan) <= 72 * Math.log2(26));
    assert.equal(digestBits(passwordBits(plan)), 128);
  });

for (const bits of [127.999, 128, 128.001, 838])
  test(`NTLM digest boundary ${bits} bits`, () => assert.equal(digestBits(bits), Math.min(bits, 128)));

test("constrained prefix bound cannot exceed a brute-force marginal min-entropy", () => {
  const plan = {
    length: 74,
    pool: ["a", "b"],
    types: [
      { name: "lowercase" as const, characters: ["a"], min: 73, max: 73 },
      { name: "uppercase" as const, characters: ["b"], min: 1, max: 1 },
    ],
  };
  // 74 equiprobable strings. The all-a 72-byte prefix has two completions.
  assert.ok(bcryptPasswordBits(plan) <= Math.log2(74 / 2));
  assert.ok(bcryptPasswordBits(plan) >= 0);
});

for (const words of [8, 9, 12])
  test(`bcrypt passphrase ${words} nine-byte words with no separator`, () => {
    const options = {
      ...defaultPassphraseOptions,
      words,
      minWordLength: 9,
      maxWordLength: 9,
      number: false,
      symbol: false,
    };
    const prefix = 8 * Math.log2(filteredWordCount(options));
    assert.equal(passphraseMaxBytes(options), words * 9);
    assert.ok(Math.abs(bcryptPassphraseBits(options) - prefix) < 1e-10);
    assert.ok(bcryptPassphraseBits(options) <= passphraseBits(options));
  });

test("long phrase counts only complete words and included number digits", () => {
  const options = {
    ...defaultPassphraseOptions,
    words: 12,
    minWordLength: 9,
    maxWordLength: 9,
    capitalize: "random" as const,
  };
  // Five 9-byte words + five 4-byte separators + seven bytes of word six.
  const bound = 5 * (Math.log2(filteredWordCount(options)) + 1) + 10 * Math.log2(10);
  assert.ok(Math.abs(bcryptPassphraseBits(options) - bound) < 1e-10);
  assert.ok(bcryptPassphraseBits(options) < passphraseBits(options));
});

test("separator byte boundary counts number digits, fixed symbols add no entropy", () => {
  const options = { ...defaultPassphraseOptions, words: 12, minWordLength: 8, maxWordLength: 8 };
  // Six (8 + 4)-byte groups exactly fill 72 bytes, with twelve number digits.
  assert.ok(
    Math.abs(bcryptPassphraseBits(options) - (6 * Math.log2(filteredWordCount(options)) + 12 * Math.log2(10))) < 1e-10,
  );
});

test("unseparated variable-length words charge for ambiguous segmentations", () => {
  const options = { ...defaultPassphraseOptions, words: 12, number: false, symbol: false };
  const bound = 8 * (Math.log2(filteredWordCount(options)) - Math.log2(5));
  assert.ok(Math.abs(bcryptPassphraseBits(options) - bound) < 1e-10);
});

for (const cap of [184, 256])
  for (const bits of [cap - 0.001, cap, cap + 0.001])
    test(`offline digest cap ${cap} at ${bits} bits`, () => {
      assert.equal(digestBits(bits, cap), Math.min(bits, cap));
      assert.ok(digestBits(bits, cap) <= cap);
    });

for (const length of [39, 40, 128])
  test(`bcrypt digest caps both short and truncated passwords (${length} characters)`, () => {
    const plan = lowercase(length);
    assert.equal(bcryptPasswordBits(plan), Math.min(bcryptPasswordPrefixBits(plan), 184));
    assert.ok(bcryptPasswordBits(plan) <= 184);
  });

for (const words of [5, 12])
  test(`passphrase ${words} words respects both slow-hash digest caps`, () => {
    const options = { ...defaultPassphraseOptions, words };
    const prefix = bcryptPassphrasePrefixBits(options);
    assert.ok(prefix < BCRYPT_BITS);
    assert.equal(bcryptPassphraseBits(options), prefix);
    const bits = passphraseBits(options);
    assert.equal(digestBits(bits, 8 * config.meter.attacks.argon2id.tagBytes), Math.min(bits, 256));
  });
