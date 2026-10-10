// The shared stored-settings validator (R26): the boot script and the app
// must make the same decision about every record, and nothing the shared
// checks accept may be refused by the generators later. Proved here over
// generated records that mix valid and invalid values in every field, with
// the compiled boot script run against each one.

import assert from "node:assert/strict";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { type BootDefaults, compileBootScript, inlineModule } from "../../scripts/lib/boot-script.ts";
import {
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_STORAGE_KEY,
  SETTINGS_TEXT_LIMIT,
  storedLimits,
} from "../../src/boot/storage.ts";
import { parseStoredText, readStoredSettings, type StoredLimits } from "../../src/boot/stored-settings.ts";
import { config } from "../../src/config/validate.ts";
import { filteredWordCount, type PassphraseOptions } from "../../src/core/passphrase.ts";
import { planPassword } from "../../src/core/password.ts";
import { defaultSettings, parseStoredSettings, validateStoredSettings } from "../../src/ui/settings.ts";

const ROOT = join(import.meta.dirname, "../..");
const limits: StoredLimits = storedLimits(config);
const bootDefaults: BootDefaults = {
  theme: config.theme,
  style: config.style.default,
  key: SETTINGS_STORAGE_KEY,
  textLimit: SETTINGS_TEXT_LIMIT,
  limits,
};

/** A small deterministic generator (xorshift32), so a failure is reproducible from its seed. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  const next = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
  return {
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (p: number) => next() < p,
  };
}

type Json = Record<string, unknown>;

/** A record with every field drawn from values around its bounds, mostly valid so the accepted side is well covered. */
function generate(r: ReturnType<typeof rng>): unknown {
  const oddNumbers = [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 0.5, 2 ** 53, "7", null, true, [], {}];
  const oddBooleans = ["true", 0, 1, null, undefined, "yes"];
  const bool = () => (r.chance(0.97) ? r.chance(0.5) : r.pick(oddBooleans));
  const int = (min: number, max: number) => {
    if (r.chance(0.03)) return r.pick(oddNumbers);
    if (r.chance(0.05)) return r.pick([min - 1, max + 1, min - 10, max + 10]);
    return r.int(min, max);
  };
  const length = int(limits.length.min, limits.length.max);
  const bound = typeof length === "number" && Number.isSafeInteger(length) ? Math.max(0, Math.min(length, 128)) : 20;
  const count = () => {
    if (r.chance(0.02)) return r.pick([null, [], "1", { min: 1 }, { min: 1, max: 1, extra: 0 }]);
    const min = r.chance(0.92) ? r.int(0, Math.min(bound, 3)) : int(0, bound);
    const max = r.chance(0.92) ? r.int(typeof min === "number" ? Math.min(min, bound) : 0, bound) : int(0, bound);
    return { min, max };
  };
  const simple = bool();
  const password: Json = {
    length,
    lowercase: bool(),
    uppercase: bool(),
    numbers: bool(),
    simple,
    complex: r.chance(0.85) ? simple === true && r.chance(0.6) : bool(),
    excludeLookAlikes: bool(),
    dontStartWithSymbol: bool(),
    counts: { lowercase: count(), uppercase: count(), numbers: count(), symbols: count() },
  };
  const minWord = int(limits.wordLength.min, limits.wordLength.max);
  const passphrase: Json = {
    words: int(limits.words.min, limits.words.max),
    minWordLength: minWord,
    maxWordLength: r.chance(0.9) && typeof minWord === "number" ? int(minWord, limits.wordLength.max) : int(3, 9),
    number: bool(),
    symbol: bool(),
    excludeLookAlikes: bool(),
    separatorSymbol: r.chance(0.95)
      ? r.pick([...limits.separators, "random", "random-unique"])
      : r.pick(["", "--", "<", "a", 5, null]),
    capitalize: r.pick(["off", "random", "every"]),
    numberDigits: r.pick([1, 2, 3]),
    symbolPosition: r.pick(["both", "before", "after"]),
  };
  const settings: Json = {
    theme: r.chance(0.95) ? r.pick(limits.themes) : r.pick(["Dark", "sepia", "", 1, null]),
    style: r.chance(0.95) ? r.pick(limits.styles) : r.pick(["ghost", "", 0, ["calm"]]),
    password: r.chance(0.97) ? password : r.pick([null, [], "20"]),
    passphrase: r.chance(0.97) ? passphrase : r.pick([null, [], 5]),
  };
  if (r.chance(0.03)) settings.extra = true;
  if (r.chance(0.02)) delete settings.style;
  // An own "__proto__" key, as JSON.parse would create one; never the prototype itself.
  if (r.chance(0.02)) Object.defineProperty(password, "__proto__", { value: { polluted: true }, enumerable: true });
  const version = r.chance(0.95) ? SETTINGS_SCHEMA_VERSION : r.pick([0, SETTINGS_SCHEMA_VERSION + 1, "1", null]);
  return r.chance(0.98) ? { version, settings } : r.pick([null, [], "x", { version }, { settings }]);
}

describe("the shared stored-settings validator", () => {
  let bootCode: string;
  before(async () => {
    bootCode = (await compileBootScript(ROOT, bootDefaults)).code;
  });

  /** The attributes the compiled boot script sets for a stored text. */
  function boot(text: string | null): { theme?: string; style?: string } {
    const dataset: Record<string, string> = {};
    const area = { getItem: (key: string) => (key === SETTINGS_STORAGE_KEY ? text : null) };
    new Function("document", "localStorage", bootCode)({ documentElement: { dataset } }, area);
    return dataset;
  }

  test("accepts the defaults and reports them unchanged", () => {
    const record = { version: SETTINGS_SCHEMA_VERSION, settings: defaultSettings(config) };
    assert.deepEqual(readStoredSettings(record, limits), defaultSettings(config));
    assert.deepEqual(boot(JSON.stringify(record)), { theme: "system", style: "calm" });
  });

  test("the limits come from the configuration", () => {
    assert.deepEqual(limits, {
      version: SETTINGS_SCHEMA_VERSION,
      themes: ["system", "light", "dark"],
      styles: config.style.offered.map((s) => s.id),
      length: { min: config.password.length.min, max: config.password.length.max },
      words: { min: config.passphrase.words.min, max: config.passphrase.words.max },
      wordLength: { min: config.passphrase.wordLength.min, max: config.passphrase.wordLength.max },
      separators: config.password.characters.simple,
    });
  });

  test("every word-length range within the limits has words, so the pool check cannot refuse an accepted record", () => {
    for (let min = limits.wordLength.min; min <= limits.wordLength.max; min++)
      for (let max = min; max <= limits.wordLength.max; max++) {
        const options: PassphraseOptions = {
          ...defaultSettings(config).passphrase,
          minWordLength: min,
          maxWordLength: max,
        };
        assert.ok(filteredWordCount(options) > 0, `${min}..${max}`);
      }
  });

  test("over generated records: the boot script, the shared checks and the app agree, and the generators accept everything accepted", () => {
    const r = rng(0x5eed_1234);
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 8000; i++) {
      const record = generate(r);
      const text = JSON.stringify(record) ?? "undefined";
      const label = `record ${i}: ${text.slice(0, 300)}`;
      const shared = readStoredSettings(record, limits);
      const app = validateStoredSettings(record, config);
      const fromText = parseStoredSettings(text, config);
      const sharedFromText = parseStoredText(text, SETTINGS_TEXT_LIMIT, limits);
      assert.equal(app !== null, shared !== null, `app and shared checks differ: ${label}`);
      assert.equal(fromText !== null, shared !== null, `text and object paths differ: ${label}`);
      assert.deepEqual(sharedFromText, shared, `shared text and object paths differ: ${label}`);
      const painted = boot(text);
      if (shared) {
        accepted++;
        assert.deepEqual(app, shared, `the app changed an accepted record: ${label}`);
        assert.deepEqual(painted, { theme: shared.theme, style: shared.style }, `boot differs: ${label}`);
        assert.doesNotThrow(() => planPassword(shared.password, config.password), `planPassword refused: ${label}`);
        assert.ok(filteredWordCount(shared.passphrase) > 0, `empty pool: ${label}`);
      } else {
        refused++;
        assert.deepEqual(painted, { theme: "system", style: "calm" }, `boot applied a refused record: ${label}`);
      }
    }
    assert.equal(({} as Json).polluted, undefined, "Object.prototype is untouched");
    // Both sides of the decision are well exercised.
    assert.ok(accepted > 1000, `accepted ${accepted}`);
    assert.ok(refused > 1000, `refused ${refused}`);
  });

  test("refuses the cheap feasibility failures the generators would also refuse", () => {
    const base = () => JSON.parse(JSON.stringify(defaultSettings(config))) as Json;
    const cases: Array<[string, (s: Json) => void]> = [
      ["Complex without Simple", (s) => ((s.password as Json).simple = false)],
      [
        "no type at all",
        (s) => {
          for (const k of ["lowercase", "uppercase", "numbers", "simple", "complex"]) (s.password as Json)[k] = false;
        },
      ],
      [
        "Min counts over the length",
        (s) => {
          (s.password as Json).length = 4;
          for (const k of ["lowercase", "uppercase", "numbers", "symbols"])
            ((s.password as Json).counts as Json)[k] = { min: 2, max: 4 };
        },
      ],
      ["Min above Max", (s) => (((s.password as Json).counts as Json).lowercase = { min: 3, max: 2 })],
      ["Max above the length", (s) => (((s.password as Json).counts as Json).numbers = { min: 0, max: 21 })],
      [
        "shortest word above the longest",
        (s) => {
          (s.passphrase as Json).minWordLength = 9;
          (s.passphrase as Json).maxWordLength = 5;
        },
      ],
    ];
    for (const [name, edit] of cases) {
      const settings = base();
      edit(settings);
      const record = { version: SETTINGS_SCHEMA_VERSION, settings };
      assert.equal(readStoredSettings(record, limits), null, name);
      assert.equal(validateStoredSettings(record, config), null, name);
      assert.deepEqual(boot(JSON.stringify(record)), { theme: "system", style: "calm" }, name);
    }
  });

  test("an accepted record's unselected types may carry any valid counts; the generators ignore them", () => {
    const settings = JSON.parse(JSON.stringify(defaultSettings(config))) as Json;
    (settings.password as Json).numbers = false;
    ((settings.password as Json).counts as Json).numbers = { min: 20, max: 20 };
    const record = { version: SETTINGS_SCHEMA_VERSION, settings };
    const shared = readStoredSettings(record, limits);
    assert.ok(shared);
    assert.deepEqual(validateStoredSettings(record, config), shared);
  });
});

describe("inlining the shared module into the boot script", () => {
  test("drops export keywords from functions, constants and types", () => {
    const out = inlineModule(
      "export function f() {}\nexport const C = 1;\nexport interface I {}\nexport type T = 1;\n",
      "m",
    );
    assert.equal(out, "function f() {}\nconst C = 1;\ninterface I {}\ntype T = 1;\n");
  });

  test("refuses imports, default exports and other export forms", () => {
    assert.throws(() => inlineModule('import x from "y";\nexport const a = 1;', "m"), /cannot import/);
    assert.throws(() => inlineModule("export default 1;", "m"), /default export/);
    assert.throws(() => inlineModule("export class K {}", "m"), /only functions, constants and types/);
    assert.throws(() => inlineModule("const a = 1;\nexport { a };", "m"), /only functions, constants and types/);
  });

  test("the shipped validator module is inlinable and the compiled script contains its checks", async () => {
    const compiled = await compileBootScript(ROOT, bootDefaults);
    assert.doesNotMatch(compiled.code, /\bimport\b|\bexport\b/);
    assert.doesNotMatch(compiled.code, /__PASSGEN_(?:BOOT|INCLUDE|TYPES)/);
    assert.ok(compiled.code.length < 4000, `small: ${compiled.code.length} bytes`);
    for (const key of ["separatorSymbol", "excludeLookAlikes", "minWordLength"])
      assert.ok(compiled.code.includes(key), key);
  });
});
