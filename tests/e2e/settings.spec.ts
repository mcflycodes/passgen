// Saved settings (R24 to R26, C3): nothing is written to any storage until
// "Save as my default" is pressed; one press saves every setting of both
// generators, the theme and the style, and they survive a reload; a change
// made after saving is not saved; "Reset to defaults" removes the record and
// restores the configured defaults; each press is confirmed visibly and to
// screen readers, with no fade under reduced motion; no generated value is
// ever written to any storage (every write is recorded, including ones
// removed at once); corrupt storage falls back to the defaults; a stored
// dark theme paints dark from the first frame; a record the app would refuse
// never paints at all; and a browser without storage, or one that refuses
// the write, still works and says it could not save.

import type { Page } from "@playwright/test";
import { SETTINGS_SCHEMA_VERSION, SETTINGS_STORAGE_KEY, storedLimits } from "../../src/boot/storage.ts";
import { config } from "../../src/config/validate.ts";
import {
  defaultSettings,
  parseStoredSettings,
  RESET_STATUS,
  SAVE_FAILED_STATUS,
  SAVE_FEEDBACK_MS,
  SAVE_INVALID_STATUS,
  SAVED_STATUS,
  serializeSettings,
} from "../../src/ui/settings.ts";
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

const RESET_FAILED_STATUS = "Reset to defaults, but could not delete saved settings from this browser.";
const KEY = SETTINGS_STORAGE_KEY;
const DEFAULT_LENGTH = String(config.password.length.default);
const DEFAULT_WORDS = String(config.passphrase.words.default);

const storedText = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY);
const storageKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage));
const setStored = (page: Page, text: string) =>
  page.evaluate(([key, value]) => localStorage.setItem(key as string, value as string), [KEY, text]);

const save = (page: Page) => page.locator("#save-settings");
const reset = (page: Page) => page.locator("#reset-settings");
const status = (page: Page) => page.locator("#save-settings-status");
const hint = (page: Page) => page.locator("#save-settings-hint");

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
  await expect(page.locator("#pw-length")).toHaveValue(DEFAULT_LENGTH);
  await expect(page.locator("#pw-numbers")).toBeChecked();
  await expect(page.locator("#pw-complex")).toBeChecked();
  await expect(page.locator("#pw-lookalikes")).not.toBeChecked();
  await expect(page.locator("#pw-no-start-symbol")).toBeChecked();
  await expect(page.locator("#pw-lowercase-min")).toHaveValue("1");
  await expect(page.locator("#pw-uppercase-max")).toHaveValue(DEFAULT_LENGTH);
  await expect(page.locator("#pp-words-number")).toHaveValue(DEFAULT_WORDS);
  await expect(page.locator("#pp-words")).toHaveValue(DEFAULT_WORDS);
  await expect(page.locator("#pp-min-length")).toHaveValue(String(config.passphrase.wordLength.defaultMin));
  await expect(page.locator("#pp-number")).toBeChecked();
  await expect(page.locator("#pp-symbol-char")).toHaveValue(config.passphrase.separator.defaultSymbol);
  await expect(page.locator("#pp-capitalize")).toHaveValue("off");
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

/** Changes a setting of every kind, so one Save covers them all. */
async function changeEverything(page: Page): Promise<void> {
  await chooseStyle(page, "purple");
  await chooseTheme(page, "dark");
  await setRange(page.locator("#pw-length"), 32);
  await page.locator("#pw-numbers").uncheck();
  await page.locator("#pw-complex").uncheck();
  await page.locator("#pw-lookalikes").check();
  await page.locator("#pw-no-start-symbol").uncheck();
  await setNumber(page.locator("#pw-lowercase-min"), 3);
  await setNumber(page.locator("#pw-uppercase-max"), 5);
  await setNumber(page.locator("#pw-symbols-min"), 2);
  await setRange(page.locator("#pp-words"), 7);
  await setNumber(page.locator("#pp-min-length"), 4);
  await setNumber(page.locator("#pp-max-length"), 6);
  await page.locator("#pp-number").uncheck();
  await page.locator("#pp-symbol-char").selectOption("random-unique");
  await page.locator("#pp-capitalize").selectOption("random");
}

const EVERYTHING_CHANGED = {
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
      dontStartWithSymbol: false,
      counts: {
        lowercase: { min: 3, max: 32 },
        uppercase: { min: 1, max: 5 },
        numbers: { min: 1, max: 32 },
        symbols: { min: 2, max: 32 },
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
      separatorSymbol: "random-unique",
      capitalize: "random" as const,
    },
  },
};

test.describe("saved settings", () => {
  test("nothing is written until Save is pressed; one press saves style, theme, both generators and the per-type counts, and they survive a reload", async ({
    page,
    watched,
  }) => {
    await watchWrites(page);
    await openPage(page);
    await expect(save(page)).toBeEnabled();
    await expect(save(page)).toHaveText("Save as my default");
    await expect(hint(page)).toContainText("Nothing generated is ever stored");
    await expect(status(page)).toHaveAttribute("role", "status");
    await expect(status(page)).toHaveAttribute("aria-live", "polite");
    await expect(status(page)).toBeEmpty();
    await changeEverything(page);
    // Every setting changed, and still nothing has touched any storage.
    expect(await recordedWrites(page)).toEqual([]);
    expect(await storageKeys(page)).toEqual([]);

    await save(page).click();
    await expect(status(page)).toHaveText(SAVED_STATUS);
    expect(await storageKeys(page)).toEqual([KEY]);
    const writes = await recordedWrites(page);
    expect(writes.map((w) => `${w.store}:${w.key}`)).toEqual([`localStorage:${KEY}`]);
    const text = await storedText(page);
    expect(text).not.toBeNull();
    expect(JSON.parse(text as string)).toEqual(EVERYTHING_CHANGED);

    await reload(page);
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
    await expect(page.locator("#pw-no-start-symbol")).not.toBeChecked();
    await expect(page.locator("#pw-lowercase-min")).toHaveValue("3");
    await expect(page.locator("#pw-uppercase-max")).toHaveValue("5");
    await expect(page.locator("#pw-symbols-min")).toHaveValue("2");
    await expect(page.locator("#pp-words-number")).toHaveValue("7");
    await expect(page.locator("#pp-min-length")).toHaveValue("4");
    await expect(page.locator("#pp-max-length")).toHaveValue("6");
    await expect(page.locator("#pp-number")).not.toBeChecked();
    await expect(page.locator("#pp-symbol-char")).toHaveValue("random-unique");
    await expect(page.locator("#pp-capitalize")).toHaveValue("random");
    // The generators use the restored settings, not just the controls.
    const password = await resultText(page, "pw-value");
    expect(password).toHaveLength(32);
    expect(password).not.toMatch(/[0-9]/);
    expect([...password].filter((c) => /[a-z]/.test(c)).length).toBeGreaterThanOrEqual(3);
    expect([...password].filter((c) => /[A-Z]/.test(c)).length).toBeLessThanOrEqual(5);
    const passphrase = await resultText(page, "pp-value");
    expect(passphrase.split(/[^A-Za-z]/)).toHaveLength(7);
    for (const word of passphrase.split(/[^A-Za-z]/)) expect(word).toMatch(/^[A-Za-z]{4,6}$/);
    expect(new Set(passphrase.match(/[^A-Za-z]/g)).size).toBe(6);
    // Loading writes nothing and leaves the stored text as it was.
    expect(await recordedWrites(page)).toEqual([]);
    expect(JSON.parse((await storedText(page)) as string)).toEqual(EVERYTHING_CHANGED);
    await expect(status(page)).toBeEmpty();
    await expectQuiet(page, watched);
  });

  test("a change made after saving is not saved: the next load opens with what was saved, not the later change", async ({
    page,
    watched,
  }) => {
    await openPage(page);
    await chooseStyle(page, "slate");
    await setRange(page.locator("#pw-length"), 24);
    await save(page).click();
    await expect(status(page)).toHaveText(SAVED_STATUS);
    const saved = await storedText(page);
    expect(JSON.parse(saved as string).settings).toMatchObject({ style: "slate", password: { length: 24 } });

    // One-off tweaks after saving: nothing in storage moves.
    await watchWrites(page);
    await chooseStyle(page, "green");
    await chooseTheme(page, "dark");
    await setRange(page.locator("#pw-length"), 40);
    await page.locator("#pp-capitalize").selectOption("random");
    await page.locator("#pw-regen").click();
    expect(await storedText(page)).toBe(saved);

    await reload(page);
    expect(await recordedWrites(page)).toEqual([]);
    await expect(page.locator("html")).toHaveAttribute("data-style", "slate");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
    await expect(page.locator("#pw-length-number")).toHaveValue("24");
    await expect(page.locator("#pp-capitalize")).toHaveValue("off");
    expect(await storedText(page)).toBe(saved);
    // Saving again replaces the record with the current settings.
    await chooseTheme(page, "light");
    await save(page).click();
    await expect(status(page)).toHaveText(SAVED_STATUS);
    expect(JSON.parse((await storedText(page)) as string).settings).toMatchObject({ theme: "light", style: "slate" });
    await expectQuiet(page, watched);
  });

  test("Reset removes the record, puts every control and both results back to the configured defaults, and says so", async ({
    page,
    watched,
  }) => {
    await openPage(page);
    await changeEverything(page);
    await save(page).click();
    await expect(status(page)).toHaveText(SAVED_STATUS);
    expect(await storageKeys(page)).toEqual([KEY]);
    const before = await resultText(page, "pw-value");

    await reset(page).focus();
    await reset(page).press("Enter");
    await expect(reset(page)).toBeFocused();
    await expect(status(page)).toHaveText(RESET_STATUS);
    await expect(reset(page)).toHaveClass(/is-done/);
    expect(await storageKeys(page)).toEqual([]);
    expect(await storedText(page)).toBeNull();
    await expectDefaults(page);
    // Both results were regenerated from the defaults.
    const password = await resultText(page, "pw-value");
    expect(password).not.toBe(before);
    expect(password).toHaveLength(config.password.length.default);
    expect(password).toMatch(/[0-9]/);
    const passphrase = await resultText(page, "pp-value");
    expect(passphrase.split(/[^A-Za-z]+/).filter(Boolean)).toHaveLength(config.passphrase.words.default);
    // Changes after Reset are as unsaved as any other; the next load is the defaults.
    await chooseStyle(page, "payload");
    expect(await storageKeys(page)).toEqual([]);
    await reload(page);
    await expectDefaults(page);
    expect(await storageKeys(page)).toEqual([]);
    await expectQuiet(page, watched);
  });

  test("Reset with nothing saved still restores the defaults and writes nothing", async ({ page, watched }) => {
    await watchWrites(page);
    await openPage(page);
    await chooseTheme(page, "dark");
    await setRange(page.locator("#pw-length"), 12);
    await reset(page).click();
    await expect(status(page)).toHaveText(RESET_STATUS);
    await expectDefaults(page);
    expect(await recordedWrites(page)).toEqual([]);
    expect(await storageKeys(page)).toEqual([]);
    await expectQuiet(page, watched);
  });

  for (const action of ["Save", "Reset"] as const) {
    test(`${action} removes the legacy v1 record and preserves unrelated storage`, async ({ page, watched }) => {
      await openPage(page);
      await page.evaluate(() => {
        localStorage.setItem("passgen:settings:v1", "old settings");
        localStorage.setItem("unrelated", "keep");
      });
      await (action === "Save" ? save(page) : reset(page)).click();
      await expect(status(page)).toHaveText(action === "Save" ? SAVED_STATUS : RESET_STATUS);
      expect(await page.evaluate(() => localStorage.getItem("passgen:settings:v1"))).toBeNull();
      expect(await page.evaluate(() => localStorage.getItem("unrelated"))).toBe("keep");
      await expectQuiet(page, watched);
    });
  }

  test("Reset reports a record that silently survives removal", async ({ page, watched }) => {
    await openPage(page);
    await save(page).click();
    await chooseTheme(page, "dark");
    await page.evaluate(() => {
      Storage.prototype.removeItem = () => {};
    });
    await reset(page).focus();
    await reset(page).press("Space");
    await expect(reset(page)).toBeFocused();
    await expect(status(page)).toHaveText(RESET_FAILED_STATUS);
    await expect(status(page)).toHaveClass(/is-error/);
    await expect(reset(page)).not.toHaveClass(/is-done/);
    await expectDefaults(page);
    expect(await storedText(page)).not.toBeNull();
    await expectQuiet(page, watched);
  });

  test.describe("feedback", () => {
    test("Save highlights the button and shows a short status that a screen reader is told about, then both end", async ({
      page,
      watched,
    }) => {
      await openPage(page);
      await expect(save(page)).not.toHaveClass(/is-done/);
      await save(page).click();
      await expect(save(page)).toHaveClass(/is-done/);
      await expect(status(page)).toHaveText(SAVED_STATUS);
      await expect(status(page)).toBeVisible();
      await expect(status(page)).toHaveAttribute("role", "status");
      await expect(status(page)).toHaveAttribute("aria-live", "polite");
      await expect(status(page)).toHaveAttribute("aria-atomic", "true");
      // Count only the highlight fade, excluding the is-done background and border-colour transitions.
      const animated = await save(page).evaluate(
        (el) =>
          el
            .getAnimations()
            .filter(
              (animation) =>
                animation instanceof CSSAnimation &&
                animation.animationName === "save-ring" &&
                (animation.playState === "running" || animation.playState === "finished"),
            ).length,
      );
      expect(animated).toBe(1);
      await expect(save(page)).not.toHaveClass(/is-done/, { timeout: SAVE_FEEDBACK_MS * 3 });
      await expect(status(page)).toBeEmpty();
      await expect(status(page)).toBeHidden();
      // Pressing again announces again.
      await save(page).click();
      await expect(status(page)).toHaveText(SAVED_STATUS);
      await expect(save(page)).toHaveClass(/is-done/);
      // Nothing generated reaches the status or the hint, in any form.
      const password = await resultText(page, "pw-value");
      const passphrase = await resultText(page, "pp-value");
      const texts = `${await status(page).textContent()}\n${await hint(page).textContent()}`;
      for (const value of [password, passphrase])
        for (const [form, needle] of encodings(value)) expect(texts, form).not.toContain(needle);
      await expectQuiet(page, watched);
    });

    test("under reduced motion the highlight changes instantly, with no animation, and still ends", async ({
      page,
      watched,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openPage(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const transitionDurations = await page.locator(".btn").evaluateAll((buttons) =>
        buttons.flatMap((button) =>
          getComputedStyle(button)
            .transitionDuration.split(",")
            .map((value) => value.trim()),
        ),
      );
      for (const duration of transitionDurations) expect(duration).toBe("0s");
      await save(page).click();
      await expect(save(page)).toHaveClass(/is-done/);
      await expect(status(page)).toHaveText(SAVED_STATUS);
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
      expect(await save(page).evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
      await expect(save(page)).not.toHaveClass(/is-done/, { timeout: SAVE_FEEDBACK_MS * 3 });
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
      await reset(page).click();
      await expect(reset(page)).toHaveClass(/is-done/);
      await expect(status(page)).toHaveText(RESET_STATUS);
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
      await expectQuiet(page, watched);
    });

    test("settings the generators refuse are not saved, and Save says what to do", async ({ page, watched }) => {
      await watchWrites(page);
      await openPage(page);
      await setNumber(page.locator("#pw-lowercase-min"), 21);
      await expect(page.locator("#pw-notice")).toBeVisible();
      await save(page).click();
      await expect(status(page)).toHaveText(SAVE_INVALID_STATUS);
      await expect(status(page)).toHaveClass(/is-error/);
      await expect(save(page)).not.toHaveClass(/is-done/);
      expect(await recordedWrites(page)).toEqual([]);
      expect(await storageKeys(page)).toEqual([]);
      await setNumber(page.locator("#pw-lowercase-min"), 1);
      await save(page).click();
      await expect(status(page)).toHaveText(SAVED_STATUS);
      expect(await storageKeys(page)).toEqual([KEY]);
      await expectQuiet(page, watched);
    });
  });

  test("a fresh load writes nothing to any storage, however briefly, whatever is changed (R24)", async ({
    page,
    watched,
  }) => {
    await watchWrites(page);
    await openPage(page);
    await chooseTheme(page, "dark");
    await chooseStyle(page, "slate");
    await setRange(page.locator("#pw-length"), 30);
    await page.locator("#pp-capitalize").selectOption("random");
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
    await chooseTheme(page, "dark");
    await save(page).click();
    await expect(status(page)).toHaveText(SAVED_STATUS);
    expect(await context.cookies()).toEqual([]);
    expect(await page.evaluate(() => document.cookie)).toBe("");
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
    expect(await storageKeys(page)).toEqual([KEY]);
  });

  test("no generated value is ever written to storage, even briefly or encoded (R25)", async ({ page }) => {
    await watchWrites(page);
    await openPage(page);
    const generated = new Set<string>();
    const collect = async () => {
      // Every element the app marks as generated output: the main results and, when they exist, the extra results.
      for (const value of await page.locator("[data-generated]").allInnerTexts()) if (value) generated.add(value);
    };
    await collect();
    await save(page).click();
    for (let i = 0; i < 3; i++) {
      await page.locator("#pw-regen").click();
      await page.locator("#pp-regen").click();
      await collect();
      await save(page).click();
    }
    await setRange(page.locator("#pw-length"), 40);
    await setRange(page.locator("#pp-words"), 3);
    await page.locator("#pp-capitalize").selectOption("random");
    await chooseTheme(page, "dark");
    await page.locator("#pw-regen").click();
    await collect();
    await save(page).click();
    await expect(status(page)).toHaveText(SAVED_STATUS);
    expect(generated.size).toBeGreaterThan(8);

    const writes = await recordedWrites(page);
    expect(writes.length).toBe(5);
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

  test.describe("without usable storage the page still works and Save says it could not save", () => {
    test("storage access is denied: the hint says so from the start, and Save explains when pressed", async ({
      page,
      watched,
    }) => {
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
      await expect(save(page)).toBeEnabled();
      await expect(hint(page)).toContainText("Saving is unavailable");
      await chooseTheme(page, "dark");
      await save(page).click();
      await expect(status(page)).toHaveText(SAVE_FAILED_STATUS);
      await expect(status(page)).toHaveClass(/is-error/);
      await expect(save(page)).not.toHaveClass(/is-done/);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      // Reset still restores the defaults in the page.
      await reset(page).click();
      await expect(status(page)).toHaveText(RESET_FAILED_STATUS);
      await expectDefaults(page);
      await expectQuiet(page, watched);
    });

    test("storage is full: nothing is tried until Save, and the press that fails explains why", async ({
      page,
      watched,
    }) => {
      await page.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        };
      });
      await watchWrites(page);
      await openPage(page);
      await expect(page.locator("#pw-value")).not.toHaveText("");
      // Nothing is tried, so nothing is known yet: no probe, no write, the hint is the usual one.
      await expect(save(page)).toBeEnabled();
      await expect(hint(page)).toContainText("Nothing generated is ever stored");
      expect(await recordedWrites(page)).toEqual([]);
      await save(page).click();
      await expect(status(page)).toHaveText(SAVE_FAILED_STATUS);
      await expect(hint(page)).toContainText("Saving is unavailable");
      await expect(save(page)).not.toHaveClass(/is-done/);
      expect(await storageKeys(page)).toEqual([]);
      await chooseTheme(page, "dark");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expectQuiet(page, watched);
    });

    test("a write the browser silently drops is reported as a failure, not a save", async ({ page, watched }) => {
      await page.addInitScript(() => {
        Storage.prototype.setItem = () => {};
      });
      await openPage(page);
      await save(page).click();
      await expect(status(page)).toHaveText(SAVE_FAILED_STATUS);
      expect(await storageKeys(page)).toEqual([]);
      await expectQuiet(page, watched);
    });

    test("when removal fails as well, nothing crashes and the page keeps working", async ({ page, watched }) => {
      await openPage(page);
      await save(page).click();
      await expect(status(page)).toHaveText(SAVED_STATUS);
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
      await save(page).click();
      await expect(status(page)).toHaveText(SAVE_FAILED_STATUS);
      await reset(page).click();
      await expect(status(page)).toHaveText(RESET_FAILED_STATUS);
      await expectDefaults(page);
      await expect(status(page)).toHaveClass(/is-error/);
      await expect(reset(page)).not.toHaveClass(/is-done/);
      expect(await storedText(page)).toBe(before);
      await page.locator("#pw-regen").click();
      await expect(page.locator("#pw-value")).not.toHaveText("");
      await expectQuiet(page, watched);
    });

    test("storage that refuses writes at load still applies the old record, and keeps it", async ({
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
      await expect(save(page)).toBeEnabled();
      expect(await storedText(page)).not.toBeNull();
      await expectQuiet(page, watched);
    });
  });
});
