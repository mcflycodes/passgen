// Saved settings (R24 to R26, C3): everything survives a reload while "Save
// current settings as default" is checked, unchecking wipes storage at once,
// corrupt storage falls back to the defaults, nothing at all is written while
// saving is off, no generated value is ever
// written to any storage (every write is recorded, including ones removed at
// once), a stored dark theme paints dark from the first frame, a record the
// app would refuse never paints at all, and a browser without storage, or
// one that stops accepting writes, still works and keeps no stale record.

import type { Page } from "@playwright/test";
import { SETTINGS_SCHEMA_VERSION, SETTINGS_STORAGE_KEY, storedLimits } from "../../src/boot/storage.ts";
import { config } from "../../src/config/validate.ts";
import { defaultSettings, parseStoredSettings, serializeSettings } from "../../src/ui/settings.ts";
import { expect, type PageWatch, test } from "./fixtures.ts";
import {
  chooseStyle,
  chooseTheme,
  isDark,
  openPage,
  pageBackground,
  resultText,
  setNumber,
  setRange,
} from "./helpers.ts";

const KEY = SETTINGS_STORAGE_KEY;
const DEFAULT_LENGTH = String(config.password.length.default);
const DEFAULT_WORDS = String(config.passphrase.words.default);

const storedText = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY);
const storageKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage));
const setStored = (page: Page, text: string) =>
  page.evaluate(([key, value]) => localStorage.setItem(key as string, value as string), [KEY, text]);

/** The stored text for the defaults with `edit` applied. */
function stored(edit: (settings: Record<string, unknown>) => void = () => {}): string {
  const settings = JSON.parse(JSON.stringify(defaultSettings(config))) as Record<string, unknown>;
  edit(settings);
  return JSON.stringify({ version: SETTINGS_SCHEMA_VERSION, settings });
}

async function reload(page: Page): Promise<void> {
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
}

async function expectDefaults(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-style", "calm");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
  await expect(page.locator("#theme-system")).toBeChecked();
  await expect(page.locator("#style")).toHaveValue("calm");
  await expect(page.locator("#pw-length-number")).toHaveValue(DEFAULT_LENGTH);
  await expect(page.locator("#pw-numbers")).toBeChecked();
  await expect(page.locator("#pw-lookalikes")).not.toBeChecked();
  await expect(page.locator("#pw-lowercase-min")).toHaveValue("1");
  await expect(page.locator("#pp-words-number")).toHaveValue(DEFAULT_WORDS);
  await expect(page.locator("#pp-capitalize")).not.toBeChecked();
  await expect(page.locator("#save-settings")).not.toBeChecked();
  await expect(page.locator("#pw-value")).not.toHaveText("");
  await expect(page.locator("#pp-value")).not.toHaveText("");
}

async function expectQuiet(page: Page, watched: PageWatch): Promise<void> {
  await page.waitForLoadState("networkidle");
  expect(watched.problems).toEqual([]);
  expect(await watched.violations()).toEqual([]);
}

/** One write the page made to a browser storage, however briefly it stayed there. */
interface StorageWrite {
  readonly store: string;
  readonly key: string;
  readonly value: string;
}

/**
 * Records every write to localStorage, sessionStorage and document.cookie
 * from the moment the document starts, before the boot script runs: the
 * method form, the property form (`localStorage.x = v`) and cookie
 * assignments. A value that is written and removed at once is still recorded.
 */
async function watchWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __writes: StorageWrite[] };
    w.__writes = [];
    const log = (store: string, key: unknown, value: unknown) =>
      w.__writes.push({ store, key: String(key), value: String(value) });
    const areas: Array<["localStorage" | "sessionStorage", Storage]> = [
      ["localStorage", window.localStorage],
      ["sessionStorage", window.sessionStorage],
    ];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      const name = areas.find(([, area]) => area === this)?.[0] ?? "storage";
      log(name, key, value);
      return setItem.call(this, key, value);
    };
    for (const [name, area] of areas) {
      const proxy = new Proxy(area, {
        set(target, prop, value) {
          log(name, prop, value);
          setItem.call(target, String(prop), String(value));
          return true;
        },
        get(target, prop) {
          const member = Reflect.get(target, prop);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
      Object.defineProperty(window, name, { configurable: true, get: () => proxy });
    }
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (cookie?.set && cookie.get) {
      const setCookie = cookie.set;
      Object.defineProperty(Document.prototype, "cookie", {
        configurable: true,
        get: cookie.get,
        set(this: Document, value: string) {
          log("cookie", "", value);
          setCookie.call(this, value);
        },
      });
    }
  });
}

const recordedWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as { __writes: StorageWrite[] }).__writes);

/** The forms a generated value could take if someone tried to hide it in a write. */
function encodings(value: string): Array<[string, string]> {
  const bytes = new TextEncoder().encode(value);
  return [
    ["plain", value],
    ["JSON-escaped", JSON.stringify(value).slice(1, -1)],
    ["URI-encoded", encodeURIComponent(value)],
    ["base64", Buffer.from(bytes).toString("base64")],
    ["base64url", Buffer.from(bytes).toString("base64url")],
    ["hex", Buffer.from(bytes).toString("hex")],
  ];
}

test.describe("saved settings", () => {
  test("nothing is stored until the box is checked; then style, theme, both generators and the per-type counts survive a reload", async ({
    page,
    watched,
  }) => {
    await openPage(page);
    await expect(page.locator("#save-settings")).not.toBeChecked();
    await expect(page.locator("#save-settings")).toBeEnabled();
    await expect(page.locator("#save-settings-hint")).toContainText("Nothing generated is ever stored");
    await chooseStyle(page, "slate");
    expect(await storageKeys(page)).toEqual([]);

    await page.locator("#save-settings").check();
    expect(await storageKeys(page)).toEqual([KEY]);

    await chooseStyle(page, "purple");
    await chooseTheme(page, "dark");
    await setRange(page.locator("#pw-length"), 32);
    await page.locator("#pw-numbers").uncheck();
    await page.locator("#pw-complex").uncheck();
    await page.locator("#pw-lookalikes").check();
    await setNumber(page.locator("#pw-lowercase-min"), 3);
    await setNumber(page.locator("#pw-uppercase-max"), 5);
    await setNumber(page.locator("#pw-symbols-min"), 2);
    await setRange(page.locator("#pp-words"), 7);
    await setNumber(page.locator("#pp-min-length"), 4);
    await setNumber(page.locator("#pp-max-length"), 6);
    await page.locator("#pp-number").uncheck();
    await page.locator("#pp-symbol-char").selectOption(".");
    await page.locator("#pp-capitalize").check();

    const text = await storedText(page);
    expect(text).not.toBeNull();
    const parsed = JSON.parse(text as string);
    expect(parsed).toEqual({
      version: SETTINGS_SCHEMA_VERSION,
      settings: {
        theme: "dark",
        style: "purple",
        password: {
          length: 32,
          lowercase: true,
          uppercase: true,
          numbers: false,
          simple: true,
          complex: false,
          excludeLookAlikes: true,
          counts: {
            lowercase: { min: 3, max: 32 },
            uppercase: { min: 1, max: 5 },
            numbers: { min: 1, max: 32 },
            symbols: { min: 2, max: 32 },
          },
        },
        passphrase: {
          words: 7,
          minWordLength: 4,
          maxWordLength: 6,
          number: false,
          symbol: true,
          separatorSymbol: ".",
          capitalize: true,
        },
      },
    });

    await reload(page);
    await expect(page.locator("#save-settings")).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-style", "purple");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("#style")).toHaveValue("purple");
    await expect(page.locator("#theme-dark")).toBeChecked();
    await expect(page.locator("#pw-length-number")).toHaveValue("32");
    await expect(page.locator("#pw-length")).toHaveValue("32");
    await expect(page.locator("#pw-numbers")).not.toBeChecked();
    await expect(page.locator("#pw-complex")).not.toBeChecked();
    await expect(page.locator("#pw-simple")).toBeChecked();
    await expect(page.locator("#pw-lookalikes")).toBeChecked();
    await expect(page.locator("#pw-lowercase-min")).toHaveValue("3");
    await expect(page.locator("#pw-uppercase-max")).toHaveValue("5");
    await expect(page.locator("#pw-symbols-min")).toHaveValue("2");
    await expect(page.locator("#pp-words-number")).toHaveValue("7");
    await expect(page.locator("#pp-min-length")).toHaveValue("4");
    await expect(page.locator("#pp-max-length")).toHaveValue("6");
    await expect(page.locator("#pp-number")).not.toBeChecked();
    await expect(page.locator("#pp-symbol-char")).toHaveValue(".");
    await expect(page.locator("#pp-capitalize")).toBeChecked();
    // The generators use the restored settings, not just the controls.
    const password = await resultText(page, "pw-value");
    expect(password).toHaveLength(32);
    expect(password).not.toMatch(/[0-9]/);
    expect([...password].filter((c) => /[a-z]/.test(c)).length).toBeGreaterThanOrEqual(3);
    expect([...password].filter((c) => /[A-Z]/.test(c)).length).toBeLessThanOrEqual(5);
    const passphrase = await resultText(page, "pp-value");
    expect(passphrase.split(".")).toHaveLength(7);
    for (const word of passphrase.split(".")) expect(word).toMatch(/^[A-Za-z]{4,6}$/);
    // The stored text is the same after the reload: loading does not rewrite it.
    expect(JSON.parse((await storedText(page)) as string)).toEqual(parsed);
    await expectQuiet(page, watched);
  });

  test("unchecking deletes the stored settings at once, and the next load opens in Calm and System", async ({
    page,
  }) => {
    await openPage(page);
    await page.locator("#save-settings").check();
    await chooseStyle(page, "payload");
    await chooseTheme(page, "light");
    await setRange(page.locator("#pw-length"), 12);
    expect(await storageKeys(page)).toEqual([KEY]);

    await page.locator("#save-settings").uncheck();
    expect(await storageKeys(page)).toEqual([]);
    expect(await storedText(page)).toBeNull();
    // Further changes while unchecked store nothing.
    await chooseStyle(page, "green");
    await setRange(page.locator("#pw-length"), 16);
    expect(await storageKeys(page)).toEqual([]);

    await reload(page);
    await expectDefaults(page);
    expect(await storageKeys(page)).toEqual([]);
  });

  test("a fresh load with saving off writes nothing to any storage, however briefly (R24)", async ({
    page,
    watched,
  }) => {
    await watchWrites(page);
    await openPage(page);
    await expect(page.locator("#save-settings")).not.toBeChecked();
    await expect(page.locator("#save-settings")).toBeEnabled();
    await chooseTheme(page, "dark");
    await chooseStyle(page, "slate");
    await setRange(page.locator("#pw-length"), 30);
    await page.locator("#pp-capitalize").check();
    await page.locator("#pw-regen").click();
    await page.locator("#pp-regen").click();
    await expect(page.locator("#pw-value")).not.toHaveText("");
    expect(await recordedWrites(page)).toEqual([]);
    expect(await storageKeys(page)).toEqual([]);
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
    await expectQuiet(page, watched);
  });

  test("the page sets no cookie and uses no other storage", async ({ page, context }) => {
    await openPage(page);
    await page.locator("#save-settings").check();
    await chooseTheme(page, "dark");
    expect(await context.cookies()).toEqual([]);
    expect(await page.evaluate(() => document.cookie)).toBe("");
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
    expect(await storageKeys(page)).toEqual([KEY]);
  });

  test("no generated value is ever written to storage, even briefly or encoded (R25)", async ({ page }) => {
    await watchWrites(page);
    await openPage(page);
    await page.locator("#save-settings").check();
    const generated = new Set<string>();
    const collect = async () => {
      // Every element the app marks as generated output: the main results and, when they exist, the extra results.
      for (const value of await page.locator("[data-generated]").allInnerTexts()) if (value) generated.add(value);
    };
    await collect();
    for (let i = 0; i < 3; i++) {
      await page.locator("#pw-regen").click();
      await page.locator("#pp-regen").click();
      await collect();
    }
    await setRange(page.locator("#pw-length"), 40);
    await setRange(page.locator("#pp-words"), 3);
    await page.locator("#pp-capitalize").check();
    await chooseTheme(page, "dark");
    await page.locator("#pw-regen").click();
    await collect();
    expect(generated.size).toBeGreaterThan(8);

    const writes = await recordedWrites(page);
    expect(writes.length).toBeGreaterThan(3);
    for (const write of writes) {
      expect(write.store, JSON.stringify(write)).toBe("localStorage");
      expect(write.key, JSON.stringify(write)).toBe(KEY);
      // Every write is a record the validator accepts: fixed keys, booleans, small integers, and
      // strings from closed sets (a theme, an offered style, a one-character separator). Nothing
      // generated fits in such a record in plain text, whatever it is.
      expect(parseStoredSettings(write.value, config), `not a settings record: ${write.value}`).not.toBeNull();
    }
    const haystack = writes.map((write) => `${write.key}\n${write.value}`).join("\n");
    // The text every write is made of: the storage key, the record's keys and every string a field
    // may hold. A needle that is part of it ("upper", "calm", "mbo" inside "symbols") cannot be
    // told from a leak by substring search, so it is left out; the record check above covers plain
    // text anyway.
    const limits = storedLimits(config);
    const fixed = [
      KEY,
      serializeSettings(defaultSettings(config), config),
      ...limits.themes,
      ...limits.styles,
      limits.separators,
    ]
      .join("\n")
      .toLowerCase();
    const needles = (text: string) => encodings(text).filter(([, needle]) => !fixed.includes(needle.toLowerCase()));
    for (const value of generated) {
      for (const [form, needle] of needles(value))
        expect(haystack, `${form} of a generated value`).not.toContain(needle);
      // Each run of letters on its own (a passphrase word, a stretch of a password), in every form,
      // as written and in lower case.
      for (const word of value.split(/[^A-Za-z]+/).filter((w) => w.length >= 3))
        for (const variant of new Set([word, word.toLowerCase()]))
          for (const [form, needle] of needles(variant))
            expect(haystack, `${form} of the word ${variant}`).not.toContain(needle);
    }
    // Every value in the stored text is a setting: a boolean, a small integer or a short string.
    const leaves: unknown[] = [];
    const walk = (value: unknown) => {
      if (value !== null && typeof value === "object") for (const v of Object.values(value)) walk(v);
      else leaves.push(value);
    };
    walk(JSON.parse((await storedText(page)) as string));
    for (const leaf of leaves) {
      if (typeof leaf === "number") expect(Number.isInteger(leaf) && leaf >= 0 && leaf <= 128).toBe(true);
      else if (typeof leaf === "string") expect(leaf.length <= 8).toBe(true);
      else expect(typeof leaf).toBe("boolean");
    }
    expect(await storageKeys(page)).toEqual([KEY]);
  });

  test.describe("corrupt or hostile storage falls back to the defaults and is removed (R26)", () => {
    const cases: Array<[string, string]> = [
      ["text that is not JSON", "{not json"],
      ["an unknown style", stored((s) => (s.style = "ghost"))],
      ["an unknown theme with a known style", stored((s) => (s.theme = "sepia"))],
      ["a wrong schema version", stored().replace(`"version":${SETTINGS_SCHEMA_VERSION}`, '"version":99')],
      [
        "a dark theme with a length below the minimum",
        stored((s) => {
          s.theme = "dark";
          (s.password as Record<string, unknown>).length = config.password.length.min - 1;
        }),
      ],
      [
        "a dark theme with a Min above its Max",
        stored((s) => {
          s.theme = "dark";
          s.style = "payload";
          ((s.password as Record<string, unknown>).counts as Record<string, unknown>).lowercase = { min: 9, max: 2 };
        }),
      ],
      ["a boolean as a string", stored((s) => ((s.password as Record<string, unknown>).lowercase = "true"))],
      ["an extra key", stored((s) => (s.generated = "hunter2"))],
      ["a __proto__ key", stored().replace('"theme"', '"__proto__":{"polluted":true},"theme"')],
      ["a huge text", stored().padEnd(100_000, " ")],
    ];
    for (const [name, text] of cases) {
      test(name, async ({ page, watched }) => {
        await openPage(page);
        await setStored(page, text);
        await reload(page);
        await expectDefaults(page);
        expect(await storedText(page)).toBeNull();
        expect(await page.evaluate(() => ({}) as Record<string, unknown>).then((o) => o.polluted)).toBeUndefined();
        await expectQuiet(page, watched);
      });
    }
  });

  test("a stored dark theme and style are on the page before any stylesheet or the body exists: no flash", async ({
    page,
    watched,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openPage(page);
    await setStored(
      page,
      stored((s) => {
        s.theme = "dark";
        s.style = "payload";
      }),
    );
    await page.addInitScript(() => {
      const w = window as unknown as { __firstPaintState?: unknown };
      const observer = new MutationObserver(() => {
        const root = document.documentElement;
        if (!root || root.dataset.theme === undefined || root.dataset.style === undefined) return;
        w.__firstPaintState = {
          theme: root.dataset.theme,
          style: root.dataset.style,
          stylesheets: document.styleSheets.length,
          hasBody: document.body !== null,
          readyState: document.readyState,
        };
        observer.disconnect();
      });
      observer.observe(document, { attributes: true, childList: true, subtree: true });
    });
    await reload(page);
    const state = await page.evaluate(() => (window as unknown as { __firstPaintState?: unknown }).__firstPaintState);
    expect(state).toEqual({ theme: "dark", style: "payload", stylesheets: 0, hasBody: false, readyState: "loading" });
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(async () => isDark(await pageBackground(page))).toBe(true);
    await expect(page.locator("#theme-dark")).toBeChecked();
    await expect(page.locator("#style")).toHaveValue("payload");
    await expect(page.locator("#save-settings")).toBeChecked();
    await expectQuiet(page, watched);
  });

  test("a stored Dark/Payload record the app would refuse (length 3) never paints: System and Calm from the first frame, even with a slow main bundle", async ({
    page,
    watched,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openPage(page);
    await setStored(
      page,
      stored((s) => {
        s.theme = "dark";
        s.style = "payload";
        (s.password as Record<string, unknown>).length = 3;
      }),
    );
    // Hold the main bundle back, so a correction by the app would be visible as a second state.
    await page.route("**/assets/index-*.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.addInitScript(() => {
      type State = { theme?: string | undefined; style?: string | undefined; stylesheets: number; hasBody: boolean };
      const w = window as unknown as { __states?: State[] };
      w.__states = [];
      const observer = new MutationObserver(() => {
        const root = document.documentElement;
        if (!root || (root.dataset.theme === undefined && root.dataset.style === undefined)) return;
        const last = w.__states?.at(-1);
        const state: State = {
          theme: root.dataset.theme,
          style: root.dataset.style,
          stylesheets: document.styleSheets.length,
          hasBody: document.body !== null,
        };
        if (!last || last.theme !== state.theme || last.style !== state.style) w.__states?.push(state);
      });
      observer.observe(document, { attributes: true, childList: true, subtree: true });
    });
    const started = Date.now();
    await reload(page);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    const states = await page.evaluate(() => (window as unknown as { __states?: unknown[] }).__states);
    // One state only, set before any stylesheet or the body existed, and never changed since.
    expect(states).toEqual([{ theme: "system", style: "calm", stylesheets: 0, hasBody: false }]);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(async () => isDark(await pageBackground(page))).toBe(false);
    await expectDefaults(page);
    expect(await storedText(page)).toBeNull();
    await expectQuiet(page, watched);
  });

  test.describe("without usable storage the page still works and the checkbox says so", () => {
    test("storage access is denied", async ({ page, watched }) => {
      await page.addInitScript(() => {
        Object.defineProperty(window, "localStorage", {
          configurable: true,
          get() {
            throw new DOMException("Access is denied for this document.", "SecurityError");
          },
        });
      });
      await openPage(page);
      await expect(page.locator("#pw-value")).not.toHaveText("");
      await expect(page.locator("#pp-value")).not.toHaveText("");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
      await expect(page.locator("#save-settings")).toBeDisabled();
      await expect(page.locator("#save-settings")).not.toBeChecked();
      await expect(page.locator("#save-settings-hint")).toContainText("Saving is unavailable");
      await chooseTheme(page, "dark");
      await expectQuiet(page, watched);
    });

    test("storage is full: the box is offered, and the tick that fails explains why", async ({ page, watched }) => {
      await page.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        };
      });
      await watchWrites(page);
      await openPage(page);
      await expect(page.locator("#pw-value")).not.toHaveText("");
      // Nothing is tried, so nothing is known yet: no probe, no write, the box is offered.
      await expect(page.locator("#save-settings")).toBeEnabled();
      await expect(page.locator("#save-settings")).not.toBeChecked();
      await expect(page.locator("#save-settings-hint")).toContainText("Kept in this browser only");
      expect(await recordedWrites(page)).toEqual([]);
      // Playwright's check() would insist the box ends up checked; the page unchecks it on failure.
      await page.locator("#save-settings").click();
      await expect(page.locator("#save-settings")).toBeDisabled();
      await expect(page.locator("#save-settings")).not.toBeChecked();
      await expect(page.locator("#save-settings-hint")).toContainText("Saving is unavailable");
      expect(await storageKeys(page)).toEqual([]);
      await chooseTheme(page, "dark");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expectQuiet(page, watched);
    });

    test("a save that starts failing removes the stored record and says so, instead of leaving a stale one", async ({
      page,
      watched,
    }) => {
      await openPage(page);
      await page.locator("#save-settings").check();
      await chooseStyle(page, "slate");
      expect(await storageKeys(page)).toEqual([KEY]);
      await page.evaluate(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        };
      });
      await chooseTheme(page, "dark");
      await expect(page.locator("#save-settings")).toBeDisabled();
      await expect(page.locator("#save-settings")).not.toBeChecked();
      await expect(page.locator("#save-settings-hint")).toContainText("Saving is unavailable");
      expect(await storedText(page)).toBeNull();
      expect(await storageKeys(page)).toEqual([]);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expectQuiet(page, watched);
    });

    test("when removal fails as well, nothing crashes and the page keeps working", async ({ page, watched }) => {
      await openPage(page);
      await page.locator("#save-settings").check();
      const before = await storedText(page);
      expect(before).not.toBeNull();
      await page.evaluate(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        };
        Storage.prototype.removeItem = () => {
          throw new DOMException("Access is denied.", "SecurityError");
        };
      });
      await chooseTheme(page, "light");
      await expect(page.locator("#save-settings")).toBeDisabled();
      await expect(page.locator("#save-settings")).not.toBeChecked();
      await expect(page.locator("#save-settings-hint")).toContainText("Saving is unavailable");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await expect(page.locator("#pw-value")).not.toHaveText("");
      await page.locator("#pw-regen").click();
      await expect(page.locator("#pw-value")).not.toHaveText("");
      await expectQuiet(page, watched);
    });

    test("storage that refuses writes at load applies the old record once, then removes it", async ({
      page,
      watched,
    }) => {
      await openPage(page);
      await setStored(
        page,
        stored((s) => {
          s.theme = "dark";
          s.style = "green";
        }),
      );
      await page.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        };
      });
      await reload(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(page.locator("html")).toHaveAttribute("data-style", "green");
      await expect(page.locator("#save-settings")).toBeDisabled();
      await expect(page.locator("#save-settings")).not.toBeChecked();
      await expect(page.locator("#save-settings-hint")).toContainText("Saving is unavailable");
      expect(await storedText(page)).toBeNull();
      await expectQuiet(page, watched);
    });
  });
});
