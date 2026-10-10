import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SETTINGS_SCHEMA_VERSION, SETTINGS_STORAGE_KEY, SETTINGS_TEXT_LIMIT } from "../../src/boot/storage.ts";
import { config } from "../../src/config/validate.ts";
import {
  browserStorage,
  createSettingsStore,
  defaultSettings,
  initialSettings,
  parseStoredSettings,
  RESET_STATUS,
  SAVE_FAILED_STATUS,
  SAVE_HINT,
  SAVE_INVALID_STATUS,
  SAVE_UNAVAILABLE_HINT,
  SAVED_STATUS,
  type Settings,
  type SettingsStorage,
  serializeSettings,
  validateStoredSettings,
} from "../../src/ui/settings.ts";

/** A JSON-compatible deep copy with `edit` applied, as a stored value. */
type Json = Record<string, unknown>;
function envelope(edit: (settings: Json) => void = () => {}): Json {
  const settings = JSON.parse(JSON.stringify(defaultSettings(config))) as Json;
  edit(settings);
  return { version: SETTINGS_SCHEMA_VERSION, settings };
}
const password = (s: Json) => s.password as Json;
const passphrase = (s: Json) => s.passphrase as Json;
const counts = (s: Json) => password(s).counts as Json;
const count = (s: Json, name: string) => counts(s)[name] as Json;

const text = (value: unknown) => JSON.stringify(value);

describe("settings store", () => {
  test("starts from the configured defaults for both generators, the theme and the style", () => {
    const settings = defaultSettings(config);
    assert.equal(settings.theme, "system");
    assert.equal(settings.style, "calm");
    assert.equal(settings.password.length, config.password.length.default);
    assert.equal(settings.password.counts.lowercase.max, config.password.length.default);
    assert.equal(settings.passphrase.words, config.passphrase.words.default);
    assert.equal(settings.passphrase.separatorSymbol, config.passphrase.separator.defaultSymbol);
  });

  test("is one plain serialisable object with no generated value in it", () => {
    const snapshot = createSettingsStore(defaultSettings(config)).snapshot();
    const json = JSON.parse(JSON.stringify(snapshot));
    assert.deepEqual(json, snapshot);
    assert.deepEqual(Object.keys(snapshot).sort(), ["passphrase", "password", "style", "theme"]);
  });

  test("updates replace top-level fields, notify subscribers, and snapshots are copies", () => {
    const store = createSettingsStore(defaultSettings(config));
    const seen: Settings[] = [];
    const stop = store.subscribe((s) => seen.push(s));
    const before = store.snapshot();
    store.update({ theme: "dark" });
    store.update({ password: { ...store.current.password, length: 32 } });
    assert.equal(seen.length, 2);
    assert.equal(store.current.theme, "dark");
    assert.equal(store.current.password.length, 32);
    assert.equal(before.password.length, config.password.length.default);
    stop();
    store.update({ style: "payload" });
    assert.equal(seen.length, 2);
    assert.equal(store.current.style, "payload");
  });
});

describe("stored settings (R24 to R26, C3)", () => {
  test("the defaults round-trip through the stored text, and every setting is in it", () => {
    const stored = serializeSettings(defaultSettings(config), config);
    assert.ok(stored);
    assert.ok(stored.length < SETTINGS_TEXT_LIMIT / 4, `room to spare: ${stored.length} characters`);
    assert.deepEqual(parseStoredSettings(stored, config), defaultSettings(config));
    const parsed = JSON.parse(stored);
    assert.deepEqual(Object.keys(parsed), ["version", "settings"]);
    assert.equal(parsed.version, SETTINGS_SCHEMA_VERSION);
    assert.deepEqual(Object.keys(parsed.settings.password).sort(), [
      "complex",
      "counts",
      "dontStartWithSymbol",
      "excludeLookAlikes",
      "length",
      "lowercase",
      "numbers",
      "simple",
      "uppercase",
    ]);
    assert.deepEqual(Object.keys(parsed.settings.passphrase).sort(), [
      "capitalize",
      "excludeLookAlikes",
      "maxWordLength",
      "minWordLength",
      "number",
      "numberDigits",
      "separatorSymbol",
      "symbol",
      "symbolPosition",
      "words",
    ]);
  });

  test("a changed setting of every kind survives the round trip", () => {
    const changed: Settings = {
      theme: "dark",
      style: "purple",
      password: {
        length: 33,
        lowercase: true,
        uppercase: false,
        numbers: true,
        simple: true,
        complex: false,
        excludeLookAlikes: true,
        dontStartWithSymbol: false,
        counts: {
          lowercase: { min: 3, max: 10 },
          uppercase: { min: 0, max: 33 },
          numbers: { min: 2, max: 2 },
          symbols: { min: 1, max: 5 },
        },
      },
      passphrase: {
        numberDigits: 2,
        symbolPosition: "both",
        words: 7,
        minWordLength: 4,
        maxWordLength: 6,
        number: false,
        symbol: true,
        excludeLookAlikes: false,
        separatorSymbol: ".",
        capitalize: "random" as const,
      },
    };
    const stored = serializeSettings(changed, config);
    assert.ok(stored);
    assert.deepEqual(parseStoredSettings(stored, config), changed);
  });

  test("the result is built from fresh objects, never the parsed value itself", () => {
    const value = envelope();
    const result = validateStoredSettings(value, config);
    assert.ok(result);
    assert.notEqual(result, value.settings);
    assert.notEqual(result.password, (value.settings as Json).password);
    assert.notEqual(result.password.counts, counts(value.settings as Json));
    assert.notEqual(result.passphrase, (value.settings as Json).passphrase);
  });

  describe("refuses, as a whole", () => {
    const refused: Array<[string, unknown]> = [
      ["a non-string", 42],
      ["undefined", undefined],
      ["an empty text", ""],
      ["text that is not JSON", "{not json"],
      ["a JSON null", "null"],
      ["a JSON string", '"dark"'],
      ["a JSON array", "[]"],
      ["an empty object", "{}"],
      ["a text above the length limit", text(envelope()).padEnd(SETTINGS_TEXT_LIMIT + 1, " ")],
      ["a huge string inside", text(envelope((s) => (s.style = "x".repeat(100_000))))],
      ["a missing version", text({ settings: envelope().settings })],
      ["a wrong version", text({ ...envelope(), version: SETTINGS_SCHEMA_VERSION + 1 })],
      ["a version as a string", text({ ...envelope(), version: String(SETTINGS_SCHEMA_VERSION) })],
      ["an extra top-level key", text({ ...envelope(), extra: true })],
      ["settings as an array", text({ version: SETTINGS_SCHEMA_VERSION, settings: [] })],
      ["settings as null", text({ version: SETTINGS_SCHEMA_VERSION, settings: null })],
      ["an extra settings key", text(envelope((s) => (s.copied = "abc")))],
      ["a missing settings key", text(envelope((s) => delete s.passphrase))],
      ["an unknown theme", text(envelope((s) => (s.theme = "sepia")))],
      ["a theme in capitals", text(envelope((s) => (s.theme = "Dark")))],
      ["a theme of the wrong type", text(envelope((s) => (s.theme = 1)))],
      ["an unknown style", text(envelope((s) => (s.style = "ghost")))],
      ["a style of the wrong type", text(envelope((s) => (s.style = ["calm"])))],
      ["a style with trailing space", text(envelope((s) => (s.style = "calm ")))],
      ["password as a string", text(envelope((s) => (s.password = "20")))],
      ["an extra password key", text(envelope((s) => (password(s).value = "hunter2")))],
      ["a missing password key", text(envelope((s) => delete password(s).complex))],
      ["a length below the minimum", text(envelope((s) => (password(s).length = config.password.length.min - 1)))],
      ["a length above the maximum", text(envelope((s) => (password(s).length = config.password.length.max + 1)))],
      ["a length as a string", text(envelope((s) => (password(s).length = "20")))],
      ["a fractional length", text(envelope((s) => (password(s).length = 20.5)))],
      ["a length of zero", text(envelope((s) => (password(s).length = 0)))],
      ["a negative length", text(envelope((s) => (password(s).length = -20)))],
      ["a boolean as a string", text(envelope((s) => (password(s).lowercase = "true")))],
      ["a boolean as a number", text(envelope((s) => (password(s).excludeLookAlikes = 1)))],
      ["a boolean as null", text(envelope((s) => (password(s).numbers = null)))],
      ["Complex without Simple (R8)", text(envelope((s) => (password(s).simple = false)))],
      [
        "no character type at all (R9)",
        text(
          envelope((s) => {
            for (const name of ["lowercase", "uppercase", "numbers", "simple", "complex"]) password(s)[name] = false;
          }),
        ),
      ],
      ["counts as an array", text(envelope((s) => (password(s).counts = [])))],
      ["a missing type in counts", text(envelope((s) => delete counts(s).symbols))],
      ["an extra type in counts", text(envelope((s) => (counts(s).emoji = { min: 0, max: 1 })))],
      ["a count with an extra key", text(envelope((s) => (count(s, "numbers").exact = 2)))],
      ["a count with a missing key", text(envelope((s) => delete count(s, "numbers").max))],
      ["a Min above its Max", text(envelope((s) => (counts(s).lowercase = { min: 5, max: 3 })))],
      ["a Max above the length", text(envelope((s) => (count(s, "uppercase").max = 21)))],
      ["a negative Min", text(envelope((s) => (count(s, "uppercase").min = -1)))],
      ["a Min as null (a NaN that was stored)", text(envelope((s) => (count(s, "numbers").min = null)))],
      ["a Min as a string", text(envelope((s) => (count(s, "numbers").min = "1")))],
      ["a fractional Max", text(envelope((s) => (count(s, "numbers").max = 2.5)))],
      [
        "Min counts that add up to more than the length (R11)",
        text(
          envelope((s) => {
            password(s).length = 4;
            for (const name of ["lowercase", "uppercase", "numbers", "symbols"]) counts(s)[name] = { min: 2, max: 4 };
          }),
        ),
      ],
      [
        "an unselected type's Min above its Max",
        text(
          envelope((s) => {
            password(s).numbers = false;
            counts(s).numbers = { min: 3, max: 1 };
          }),
        ),
      ],
      ["passphrase as null", text(envelope((s) => (s.passphrase = null)))],
      ["an extra passphrase key", text(envelope((s) => (passphrase(s).value = "a-b-c")))],
      ["a missing passphrase key", text(envelope((s) => delete passphrase(s).capitalize))],
      ["too few words", text(envelope((s) => (passphrase(s).words = config.passphrase.words.min - 1)))],
      ["too many words", text(envelope((s) => (passphrase(s).words = config.passphrase.words.max + 1)))],
      ["words as a string", text(envelope((s) => (passphrase(s).words = "5")))],
      ["a word length below the list's shortest", text(envelope((s) => (passphrase(s).minWordLength = 2)))],
      ["a word length above the list's longest", text(envelope((s) => (passphrase(s).maxWordLength = 10)))],
      [
        "a shortest word length above the longest",
        text(
          envelope((s) => {
            passphrase(s).minWordLength = 7;
            passphrase(s).maxWordLength = 6;
          }),
        ),
      ],
      ["Capitalize as a string", text(envelope((s) => (passphrase(s).capitalize = "yes")))],
      ["an empty separator", text(envelope((s) => (passphrase(s).separatorSymbol = "")))],
      ["a two-character separator", text(envelope((s) => (passphrase(s).separatorSymbol = "--")))],
      ["a Complex symbol as separator", text(envelope((s) => (passphrase(s).separatorSymbol = "<")))],
      ["a letter as separator", text(envelope((s) => (passphrase(s).separatorSymbol = "a")))],
      ["a separator of the wrong type", text(envelope((s) => (passphrase(s).separatorSymbol = 45)))],
      ["a __proto__ key at the top", `{"__proto__":{"polluted":true},${text(envelope()).slice(1)}`],
      ["a __proto__ key in settings", text(envelope()).replace('"theme"', '"__proto__":{"polluted":true},"theme"')],
      ["a __proto__ key in password", text(envelope()).replace('"length"', '"__proto__":{"polluted":true},"length"')],
      [
        "a __proto__ key in a count",
        text(envelope()).replace('"lowercase":{"min"', '"lowercase":{"__proto__":{"polluted":true},"min"'),
      ],
      [
        "a constructor key",
        text(envelope()).replace('"theme"', '"constructor":{"prototype":{"polluted":true}},"theme"'),
      ],
      ["a prototype key", text(envelope()).replace('"theme"', '"prototype":{"polluted":true},"theme"')],
      ["a __proto__ key in place of a count", text(envelope()).replace('"symbols"', '"__proto__"')],
    ];
    for (const [name, value] of refused) {
      test(name, () => {
        assert.equal(parseStoredSettings(value, config), null);
        assert.equal(({} as Json).polluted, undefined, "Object.prototype is untouched");
      });
    }
  });

  describe("refuses values JSON cannot carry when given a parsed object", () => {
    for (const [name, bad] of [
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
      ["an unsafe integer", 2 ** 53],
      ["a bigint", 20n],
      ["a Number object", new Number(20)],
    ] as const) {
      test(`${name} as the length and as a count`, () => {
        const asLength = envelope();
        password(asLength.settings as Json).length = bad as unknown;
        assert.equal(validateStoredSettings(asLength, config), null);
        const asCount = envelope();
        count(asCount.settings as Json, "numbers").max = bad as unknown;
        assert.equal(validateStoredSettings(asCount, config), null);
      });
    }
    test("an object with a prototype that supplies the keys", () => {
      const value = envelope();
      const proto = { ...password(value.settings as Json) };
      (value.settings as Json).password = Object.create(proto);
      assert.equal(validateStoredSettings(value, config), null);
    });
  });

  test("serialises nothing while a setting is mid-edit or otherwise invalid", () => {
    const base = defaultSettings(config);
    const typing: Settings = {
      ...base,
      password: { ...base.password, counts: { ...base.password.counts, numbers: { min: Number.NaN, max: 20 } } },
    };
    assert.equal(serializeSettings(typing, config), null);
    const weak: Settings = { ...base, password: { ...base.password, length: 3 } };
    assert.equal(serializeSettings(weak, config), null);
  });
});

describe("the storage adapter and the initial settings", () => {
  /** A fake storage area; `writes` records every setItem and removeItem call, failed ones included. */
  function fakeArea(fail: { set?: boolean; get?: boolean; remove?: boolean; drop?: boolean } = {}) {
    const items = new Map<string, string>();
    const writes: string[] = [];
    const area = {
      getItem(key: string) {
        if (fail.get) throw new Error("denied");
        return items.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        writes.push(`set ${key}`);
        if (fail.set) throw new Error("QuotaExceededError");
        if (!fail.drop) items.set(key, value);
      },
      removeItem(key: string) {
        writes.push(`remove ${key}`);
        if (fail.remove) throw new Error("denied");
        items.delete(key);
      },
    } as unknown as Storage;
    return { area, items, writes };
  }

  test("reads, writes and removes under the one key and nothing else", () => {
    const { area, items, writes } = fakeArea();
    const storage = browserStorage(() => area);
    assert.ok(storage);
    assert.equal(storage.read(), null);
    assert.deepEqual(writes, [], "opening and reading write nothing: no probe");
    assert.equal(storage.write("x"), true);
    assert.deepEqual([...items.keys()], [SETTINGS_STORAGE_KEY]);
    assert.equal(storage.read(), "x");
    assert.equal(storage.remove(), true);
    assert.deepEqual([...items.keys()], []);
    assert.deepEqual(writes, [`set ${SETTINGS_STORAGE_KEY}`, `remove ${SETTINGS_STORAGE_KEY}`]);
  });

  for (const action of ["write", "remove"] as const) {
    test(`${action} removes legacy settings without touching unrelated keys`, () => {
      const { area, items } = fakeArea();
      items.set("passgen:settings:v1", "legacy");
      items.set("other", "keep");
      const storage = browserStorage(() => area) as SettingsStorage;
      assert.equal(action === "write" ? storage.write("new") : storage.remove(), true);
      assert.equal(items.has("passgen:settings:v1"), false);
      assert.equal(items.get("other"), "keep");
    });
  }

  test("removal that throws reports failure even without a record", () => {
    const { area } = fakeArea({ remove: true });
    assert.equal(browserStorage(() => area)?.remove(), false);
  });

  test("makes no write at all when the page starts with nothing stored (R24: written only when Save is pressed)", () => {
    const { area, writes } = fakeArea();
    const storage = browserStorage(() => area) as SettingsStorage;
    assert.deepEqual(initialSettings(config, storage), { settings: defaultSettings(config), stored: false });
    assert.deepEqual(writes, []);
  });

  test("a write the browser silently drops reports false", () => {
    const { area } = fakeArea({ drop: true });
    const storage = browserStorage(() => area) as SettingsStorage;
    assert.equal(storage.write("x"), false);
    assert.equal(storage.read(), null);
  });

  test("is null only when the area cannot even be read", () => {
    assert.equal(
      browserStorage(() => {
        throw new Error("SecurityError");
      }),
      null,
    );
    assert.equal(
      browserStorage(() => undefined as unknown as Storage),
      null,
    );
    assert.equal(
      browserStorage(() => fakeArea({ get: true }).area),
      null,
    );
  });

  test("a storage that refuses writes is still returned, reports the refusal, and can still remove a record", () => {
    const { area, items } = fakeArea({ set: true });
    items.set(SETTINGS_STORAGE_KEY, "old");
    const storage = browserStorage(() => area);
    assert.ok(storage);
    assert.equal(storage.write("new"), false);
    assert.equal(storage.read(), "old");
    assert.equal(storage.remove(), true);
    assert.equal(storage.read(), null);
  });

  test("a storage that refuses writes and removals reports the record as still there, without throwing", () => {
    const { area, items } = fakeArea({ set: true, remove: true });
    items.set(SETTINGS_STORAGE_KEY, "old");
    const storage = browserStorage(() => area);
    assert.ok(storage);
    assert.equal(storage.remove(), false);
    assert.equal(storage.read(), "old");
  });

  test("a write that starts failing reports false instead of throwing", () => {
    const fail = { set: false };
    const storage = browserStorage(() => fakeArea(fail).area);
    assert.ok(storage);
    assert.equal(storage.write("x"), true);
    fail.set = true;
    assert.equal(storage.write("y"), false);
    assert.equal(storage.read(), "x");
  });

  test("starts from valid stored settings, and from the defaults with nothing stored or no storage", () => {
    const { area, items } = fakeArea();
    const storage = browserStorage(() => area) as SettingsStorage;
    assert.deepEqual(initialSettings(config, storage), { settings: defaultSettings(config), stored: false });
    assert.deepEqual(initialSettings(config, null), { settings: defaultSettings(config), stored: false });
    const dark = { ...defaultSettings(config), theme: "dark" as const, style: "slate" };
    items.set(SETTINGS_STORAGE_KEY, serializeSettings(dark, config) as string);
    assert.deepEqual(initialSettings(config, storage), { settings: dark, stored: true });
  });

  test("the Save and Reset texts say what happens, in one short sentence or two, and are fixed strings", () => {
    assert.match(SAVED_STATUS, /^Saved/);
    assert.match(RESET_STATUS, /^Reset to defaults/);
    assert.match(SAVE_FAILED_STATUS, /^Could not save/);
    assert.match(SAVE_INVALID_STATUS, /^Could not save/);
    assert.match(SAVE_HINT, /not saved unless you save again/);
    assert.match(SAVE_HINT, /Nothing generated is ever stored/);
    assert.match(SAVE_UNAVAILABLE_HINT, /unavailable/);
    for (const text of [SAVED_STATUS, RESET_STATUS, SAVE_FAILED_STATUS, SAVE_INVALID_STATUS, SAVE_HINT])
      assert.ok(text.length <= 200 && !text.includes("\n"), text);
  });

  test("discards corrupt stored settings, removes them and starts from the defaults (R26)", () => {
    const { area, items } = fakeArea();
    const storage = browserStorage(() => area) as SettingsStorage;
    items.set(SETTINGS_STORAGE_KEY, text(envelope((s) => (password(s).length = 2))));
    assert.deepEqual(initialSettings(config, storage), { settings: defaultSettings(config), stored: false });
    assert.equal(items.has(SETTINGS_STORAGE_KEY), false);
  });
});
