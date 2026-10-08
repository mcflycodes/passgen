import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseSync } from "vite";
import { type BootDefaults, compileBootScript } from "../../scripts/lib/boot-script.ts";
import {
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_STORAGE_KEY,
  SETTINGS_TEXT_LIMIT,
  storedLimits,
} from "../../src/boot/storage.ts";
import { config } from "../../src/config/validate.ts";
import { defaultSettings, parseStoredSettings } from "../../src/ui/settings.ts";

const ROOT = join(import.meta.dirname, "../..");
const limits = { ...storedLimits(config), styles: ["calm", "payload"] };
const defaults: BootDefaults = {
  theme: "system",
  style: "calm",
  key: SETTINGS_STORAGE_KEY,
  textLimit: SETTINGS_TEXT_LIMIT,
  limits,
};

/** A fake localStorage: `text` is what getItem returns, or a function that throws. */
function fakeStorage(text: string | null | (() => never)) {
  return {
    getItem(key: string) {
      if (key !== SETTINGS_STORAGE_KEY) return null;
      return typeof text === "function" ? text() : text;
    },
  };
}

/** Runs the compiled script against a bare document and the given storage, returning the attributes it set. */
async function run(bootDefaults: BootDefaults, text: string | null | (() => never)) {
  const boot = await compileBootScript(ROOT, bootDefaults);
  const dataset: Record<string, string> = {};
  new Function("document", "localStorage", boot.code)({ documentElement: { dataset } }, fakeStorage(text));
  return dataset;
}

/** The stored text for the shipped defaults with the given theme and style. */
function stored(theme: unknown, style: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: SETTINGS_SCHEMA_VERSION,
    settings: { ...defaultSettings(config), theme, style, ...extra },
  });
}

describe("the boot script", () => {
  test("compiles to a small classic script that carries the defaults and no placeholder", async () => {
    const boot = await compileBootScript(ROOT, defaults);
    assert.match(boot.fileName, /^assets\/boot-[0-9a-f]{8}\.js$/);
    assert.ok(boot.code.length < 4000, `small: ${boot.code.length} bytes`);
    assert.doesNotMatch(boot.code, /__PASSGEN_BOOT__/);
    assert.doesNotMatch(boot.code, /\bimport\b|\bexport\b/);
    assert.match(boot.code, /payload/);
    assert.ok(boot.code.includes(SETTINGS_STORAGE_KEY));
    const { errors } = parseSync("boot.js", boot.code, { sourceType: "script" });
    assert.deepEqual(errors, []);
  });

  test("applies the defaults to a document before any stylesheet exists, with no storage at all", async () => {
    const boot = await compileBootScript(ROOT, { ...defaults, theme: "dark", style: "payload" });
    const dataset: Record<string, string> = {};
    // No localStorage binding: referencing it throws, as in a context without storage.
    new Function("document", boot.code)({ documentElement: { dataset } });
    assert.deepEqual(dataset, { theme: "dark", style: "payload" });
  });

  test("falls back to the first offered style when the default is not offered", async () => {
    assert.deepEqual(await run({ ...defaults, theme: "light", style: "ghost" }, null), {
      theme: "light",
      style: "calm",
    });
  });

  test("the file name changes with the defaults", async () => {
    const a = await compileBootScript(ROOT, defaults);
    const b = await compileBootScript(ROOT, { ...defaults, theme: "dark" });
    assert.notEqual(a.fileName, b.fileName);
  });

  describe("saved theme and style (R24, R26)", () => {
    test("a stored theme and offered style replace the defaults before the first paint", async () => {
      assert.deepEqual(await run(defaults, stored("dark", "payload")), { theme: "dark", style: "payload" });
      assert.deepEqual(await run(defaults, stored("light", "calm")), { theme: "light", style: "calm" });
    });

    test("never throws and keeps the defaults when storage is denied, empty or holds something else", async () => {
      const denied = () => {
        throw new Error("SecurityError: storage is disabled");
      };
      for (const text of [
        denied,
        null,
        "",
        "not json",
        "null",
        "[]",
        '"dark"',
        "{}",
        JSON.stringify({ version: SETTINGS_SCHEMA_VERSION }),
        JSON.stringify({ version: SETTINGS_SCHEMA_VERSION, settings: null }),
        JSON.stringify({ version: SETTINGS_SCHEMA_VERSION, settings: ["dark", "payload"] }),
        JSON.stringify({ version: SETTINGS_SCHEMA_VERSION, settings: { theme: "dark", style: "payload" } }),
        `${stored("dark", "payload").slice(0, -1)},"extra":1}`,
        stored("dark", "payload", { extra: 1 }),
      ]) {
        assert.deepEqual(await run(defaults, text), { theme: "system", style: "calm" }, String(text));
      }
    });

    test("refuses a wrong or missing version, so a copied or edited value never applies", async () => {
      for (const version of [undefined, 0, 2, "1", null, [1]]) {
        const text = JSON.stringify({
          version,
          settings: { ...defaultSettings(config), theme: "dark", style: "payload" },
        });
        assert.deepEqual(await run(defaults, text), { theme: "system", style: "calm" }, String(version));
      }
    });

    test("an unknown theme or style discards both, as the app does", async () => {
      for (const [theme, style] of [
        ["dark", "ghost"],
        ["night", "payload"],
        [1, "payload"],
        ["dark", 2],
        [null, "payload"],
        ["dark", ["payload"]],
        ["DARK", "payload"],
        ["dark", "Payload"],
        ["dark", "payload "],
      ] as const) {
        assert.deepEqual(
          await run(defaults, stored(theme, style)),
          { theme: "system", style: "calm" },
          `${theme} ${style}`,
        );
      }
    });

    test("a record the app would refuse for its generator settings is not applied either: no flash to undo", async () => {
      const weak = stored("dark", "payload", {
        password: { ...defaultSettings(config).password, length: config.password.length.min - 1 },
      });
      assert.deepEqual(await run(defaults, weak), { theme: "system", style: "calm" });
      assert.equal(parseStoredSettings(weak, config), null);
      const crossed = stored("dark", "payload", {
        password: {
          ...defaultSettings(config).password,
          counts: { ...defaultSettings(config).password.counts, lowercase: { min: 9, max: 2 } },
        },
      });
      assert.deepEqual(await run(defaults, crossed), { theme: "system", style: "calm" });
      assert.equal(parseStoredSettings(crossed, config), null);
    });

    test("ignores a stored text above the length limit without parsing it", async () => {
      const text = stored("dark", "payload").padEnd(SETTINGS_TEXT_LIMIT + 1, " ");
      assert.deepEqual(await run(defaults, text), { theme: "system", style: "calm" });
      const fits = stored("dark", "payload").padEnd(SETTINGS_TEXT_LIMIT, " ");
      assert.deepEqual(await run(defaults, fits), { theme: "dark", style: "payload" });
    });

    test("prototype keys in the stored text neither apply nor pollute", async () => {
      const hostile = [
        '{"version":1,"settings":{"__proto__":{"theme":"dark","style":"payload"}}}',
        '{"__proto__":{"version":1,"settings":{"theme":"dark","style":"payload"}}}',
        stored("dark", "payload").replace('"theme"', '"constructor":{"prototype":{"polluted":true}},"theme"'),
        stored("dark", "payload").replace('"length"', '"__proto__":{"polluted":true},"length"'),
      ];
      for (const text of hostile) assert.deepEqual(await run(defaults, text), { theme: "system", style: "calm" }, text);
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
      assert.equal(({} as Record<string, unknown>).theme, undefined);
    });

    test("agrees with the app's validator on every stored theme and style", async () => {
      const shipped = { ...defaults, limits: storedLimits(config) };
      const cases: unknown[][] = [];
      for (const theme of ["system", "light", "dark", "Dark", "", 0, null, undefined, true])
        for (const style of [...shipped.limits.styles, "ghost", "", 0, null, undefined, false])
          cases.push([theme, style]);
      for (const [theme, style] of cases) {
        const text = stored(theme, style);
        const app = parseStoredSettings(text, config);
        const boot = await run(shipped, text);
        const expected = app ? { theme: app.theme, style: app.style } : { theme: "system", style: "calm" };
        assert.deepEqual(boot, expected, `${String(theme)} / ${String(style)}`);
      }
    });
  });
});
