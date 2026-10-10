import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS_SCHEMA_VERSION, storedLimits } from "../../src/boot/storage.ts";
import { readStoredSettings } from "../../src/boot/stored-settings.ts";
import { config, validateConfig } from "../../src/config/validate.ts";
import { passphraseEntropy } from "../../src/core/entropy.ts";
import {
  defaultPassphraseOptions,
  effectiveSeparatorSymbol,
  filteredWordCount,
  generatePassphrase,
  separatorSymbols,
} from "../../src/core/passphrase.ts";
import { defaultSettings, parseStoredSettings, serializeSettings } from "../../src/ui/settings.ts";
import { wordsSource } from "./random-sources.ts";

test("separator look-alike configuration is a unique simple-symbol subset with a usable fallback", () => {
  assert.equal(config.passphrase.separator.lookAlikes, "!()._");
  assert.equal(defaultPassphraseOptions.excludeLookAlikes, false);
  assert.equal(config.passphrase.separator.defaultFixedSymbol, "-");
  for (const lookAlikes of ["a", "!!", config.password.characters.simple]) {
    const copy = structuredClone(config);
    copy.passphrase.separator.lookAlikes = lookAlikes;
    assert.throws(() => validateConfig(copy), /passphrase.separator.lookAlikes/);
  }
  const copy = structuredClone(config);
  copy.passphrase.separator.excludeLookAlikes = true;
  validateConfig(copy);
  copy.passphrase.separator.defaultFixedSymbol = "!";
  assert.throws(() => validateConfig(copy), /defaultFixedSymbol/);
});

test("filtered separator pool applies in random, unique and every fixed mode without changing words or digits", () => {
  const options = { ...defaultPassphraseOptions, excludeLookAlikes: true, words: 12 };
  assert.deepEqual(separatorSymbols(options), [..."@#$^*-?"]);
  assert.deepEqual(separatorSymbols({ ...options, excludeLookAlikes: false }), [...config.password.characters.simple]);
  for (const separatorSymbol of ["random", "random-unique", ...config.password.characters.simple]) {
    const value = generatePassphrase({ ...options, separatorSymbol }, wordsSource(Array(300).fill(0)));
    const symbols = [...value].filter((char) => config.password.characters.simple.includes(char));
    assert.equal(symbols.length, 22);
    assert.ok(symbols.every((char) => "@#$^*-?".includes(char)));
    const baseline = generatePassphrase(
      { ...options, separatorSymbol: "-", excludeLookAlikes: false },
      wordsSource(Array(300).fill(0)),
    );
    assert.equal(value.replace(/[^a-z0-9]/g, ""), baseline.replace(/[^a-z0-9]/g, ""));
    if (separatorSymbol === "random-unique") {
      const counts = new Map([..."@#$^*-?"].map((char) => [char, 0]));
      symbols.forEach((char, index) => {
        const count = counts.get(char) as number;
        assert.equal(count, Math.min(...counts.values()));
        counts.set(char, count + 1);
        if (index % 2) assert.notEqual(char, symbols[index - 1]);
      });
    }
  }
});

test("excluded fixed separators fall back to the configured fixed symbol", () => {
  for (const separatorSymbol of config.password.characters.simple) {
    const options = { ...defaultPassphraseOptions, excludeLookAlikes: true, separatorSymbol };
    assert.equal(effectiveSeparatorSymbol(options), "!()._".includes(separatorSymbol) ? "-" : separatorSymbol);
    assert.equal(effectiveSeparatorSymbol({ ...options, excludeLookAlikes: false }), separatorSymbol);
  }
});

test("filtered default entropy is exact and unchecked default stays unchanged", () => {
  const options = { ...defaultPassphraseOptions, excludeLookAlikes: true };
  const expected = BigInt(filteredWordCount(options)) ** 5n * 10n ** 8n * 7n ** 8n;
  assert.equal(passphraseEntropy(options).count, expected);
  assert.equal(passphraseEntropy().count, BigInt(filteredWordCount()) ** 5n * 10n ** 8n * 12n ** 8n);
  assert.equal(Math.floor(passphraseEntropy().bits * 10) / 10, 119.3);
  const expectedBits = Math.log2(Number(expected));
  assert.ok(Math.abs(passphraseEntropy(options).bits - expectedBits) < 1e-12);
  const slots = 2 * (options.words - 1);
  assert.ok(Math.abs(passphraseEntropy(options).bits - (passphraseEntropy().bits - slots * Math.log2(12 / 7))) < 1e-12);
  assert.equal(Math.floor(expectedBits * 10) / 10, 113.1);
});

test("separator look-alike settings round trip and reject missing or non-boolean switches", () => {
  for (const excludeLookAlikes of [true, false]) {
    const settings = defaultSettings(config);
    const changed = { ...settings, passphrase: { ...settings.passphrase, excludeLookAlikes } };
    const text = serializeSettings(changed, config);
    assert.ok(text);
    assert.deepEqual(parseStoredSettings(text, config), changed);
  }
  for (const excludeLookAlikes of [undefined, null, 0, 1, "true", [], {}]) {
    const settings = defaultSettings(config);
    const record = {
      version: SETTINGS_SCHEMA_VERSION,
      settings: { ...settings, passphrase: { ...settings.passphrase, excludeLookAlikes } },
    };
    assert.equal(readStoredSettings(record, storedLimits(config)), null);
  }
});
