import { AxeBuilder } from "@axe-core/playwright";
import { SETTINGS_STORAGE_KEY } from "../../src/boot/storage.ts";
import { config } from "../../src/config/validate.ts";
import { passphraseBits } from "../../src/core/entropy.ts";
import { defaultPassphraseOptions, filteredWordCount } from "../../src/core/passphrase.ts";
import { WORD_LISTS } from "../../src/core/wordlists.ts";

const WORDS = WORD_LISTS["orchard-long"].words;

import { futureEstimate } from "../../src/ui/meter.ts";
import { expect, test } from "./fixtures.ts";
import { openPage, setNumber, setRange } from "./helpers.ts";

const bits = async (page: import("@playwright/test").Page, prefix: string) =>
  Number.parseFloat(await page.locator(`#${prefix}-bits`).innerText());

test("default text equivalents, six coloured segments and attack assumptions", async ({ page }) => {
  await openPage(page);
  await expect(page.locator("#pw-band")).toHaveText("Excellent");
  await expect(page.locator("#pp-band")).toHaveText("Very strong");
  await expect(page.locator("#pw-meter .seg")).toHaveCount(6);
  const colors = await page
    .locator("#pw-meter .seg")
    .evaluateAll((segments) => segments.map((el) => getComputedStyle(el).backgroundColor));
  expect(new Set(colors).size).toBe(6);
  await expect(page.locator("#pw-headline")).toContainText("Average offline crack time (NTLM)");
  await expect(page.locator("#pw-scenarios")).toContainText("8 high-end GPUs, NTLM");
  await page.locator("#pw-meter summary").click();
  await expect(page.locator("#pw-scenarios")).toContainText("bcrypt cost 12");
  await expect(page.locator("#pw-scenarios")).toContainText(config.meter.attacks.argon2id.parameters);
  await expect(page.locator("#pw-scenarios")).toContainText("100 distinct guesses");
  await expect(page.locator("#pw-future")).toBeHidden();
  await expect(page.locator("#pw-quantum")).toHaveText(config.meter.quantum.current);
  expect(await page.locator("body").innerText()).not.toMatch(/quantum[-\s]+(?:safe|proof)/i);
});

test("both meters change with settings and tighter Min/Max lowers password strength", async ({ page }) => {
  await openPage(page);
  const original = await bits(page, "pw");
  await setNumber(page.locator("#pw-symbols-max"), 1);
  expect(await bits(page, "pw")).toBeLessThan(original);
  const capped = await bits(page, "pw");
  await setNumber(page.locator("#pw-lowercase-min"), 15);
  expect(await bits(page, "pw")).toBeLessThan(capped);
  await setRange(page.locator("#pw-length"), 128);
  await expect(page.locator("#pw-headline")).not.toContainText(/Infinity|NaN/);
  const phrase = await bits(page, "pp");
  await page.locator("#pp-number").uncheck();
  expect(await bits(page, "pp")).toBeLessThan(phrase);
  const noNumbers = await bits(page, "pp");
  await page.locator("#pp-capitalize").selectOption("random");
  expect(await bits(page, "pp")).toBeCloseTo(noNumbers + 5, 1);
});

test("invalid password settings clear the previous rating and recover", async ({ page }) => {
  await openPage(page);
  await setNumber(page.locator("#pw-lowercase-min"), 20);
  await expect(page.locator("#pw-band")).toContainText("Invalid settings");
  await expect(page.locator("#pw-bits")).toBeEmpty();
  await expect(page.locator("#pw-headline")).toBeEmpty();
  await expect(page.locator("#pw-scenarios")).toBeEmpty();
  await expect(page.locator("#pw-regen")).toBeDisabled();
  await expect(page.locator("#pw-meter")).toHaveAttribute("data-level", "");
  await expect(page.locator("#pw-quantum")).toHaveText(config.meter.quantum.current);
  await setNumber(page.locator("#pw-lowercase-min"), 1);
  await expect(page.locator("#pw-band")).toHaveText("Excellent");
});

test("a small R13 pool warns while generation stays available", async ({ page }) => {
  await openPage(page);
  await page.locator("#pp-symbol-char").selectOption("-");
  await setNumber(page.locator("#pp-min-length"), 3);
  await setNumber(page.locator("#pp-max-length"), 3);
  await expect(page.locator("#pp-meter-warning")).toBeVisible();
  await expect(page.locator("#pp-meter-warning")).toContainText("less than 80 bits");
  await expect(page.locator("#pp-meter-warning")).toContainText(
    `shrinks the pool to ${filteredWordCount({ ...defaultPassphraseOptions, minWordLength: 3, maxWordLength: 3 })} words`,
  );
  await expect(page.locator("#pp-regen")).toBeEnabled();
  await setNumber(page.locator("#pp-max-length"), 9);
  await expect(page.locator("#pp-meter-warning")).toBeHidden();
});

test("an empty R13 pool uses the panel disable path and clears the meter", async ({ page }) => {
  // Controlled future-list fixture: remove all 3-letter words from the built
  // bundle before load. The production list has no empty allowed range.
  const shortWords = WORDS.filter((word) => word.length === 3);
  let replaced = 0;
  await page.route("**/assets/index-*.js", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    const original = WORDS.join(" ");
    if (body.includes(original)) replaced = shortWords.length;
    body = body.replace(original, WORDS.filter((word) => word.length !== 3).join(" "));
    await route.fulfill({ response, body });
  });
  await openPage(page);
  expect(replaced).toBe(shortWords.length);
  await setNumber(page.locator("#pp-words-number"), 2);
  await expect(page.locator("#pp-meter-warning")).toBeVisible();
  await setNumber(page.locator("#pp-min-length"), 3);
  await setNumber(page.locator("#pp-max-length"), 3);
  await expect(page.locator("#pp-band")).toContainText("No words remain");
  await expect(page.locator("#pp-meter-warning")).toBeHidden();
  await expect(page.locator("#pp-meter-warning")).toBeEmpty();
  await expect(page.locator("#pp-meter-warning")).toHaveJSProperty("hidden", true);
  await expect(page.locator("#pp-bits")).toBeEmpty();
  await expect(page.locator("#pp-value")).toBeEmpty();
  await expect(page.locator("#pp-copy")).toBeDisabled();
  await expect(page.locator("#pp-regen")).toBeDisabled();
  await setNumber(page.locator("#pp-max-length"), 9);
  await expect(page.locator("#pp-regen")).toBeEnabled();
});

test("polite announcements settle once after a burst of changes", async ({ page }) => {
  await openPage(page);
  await expect(page.locator("#pw-meter-status")).toContainText("Excellent");
  await page.locator("#pw-meter-status").evaluate(async (el) => {
    const host = window as typeof window & {
      meterAnnouncements: number;
      lastMeterInput: number;
      announcementTime: number;
    };
    host.meterAnnouncements = 0;
    new MutationObserver(() => {
      if (!el.textContent) return;
      host.meterAnnouncements++;
      host.announcementTime = performance.now();
    }).observe(el, { childList: true });
    const range = document.querySelector<HTMLInputElement>("#pw-length");
    if (!range) throw new Error("Missing range");
    for (const value of [10, 11, 12]) {
      range.value = String(value);
      host.lastMeterInput = performance.now();
      range.dispatchEvent(new Event("input", { bubbles: true }));
      // Separate browser tasks let synchronous and zero-delay announcements
      // become observable instead of batching into one observer callback.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  expect(await page.evaluate(() => (window as typeof window & { meterAnnouncements: number }).meterAnnouncements)).toBe(
    0,
  );
  await expect(page.locator("#pw-meter-status")).toContainText("Moderate");
  // Wait beyond all timers, so a queued extra announcement also fails.
  await page.waitForTimeout(600);
  const observed = await page.evaluate(() => {
    const host = window as typeof window & {
      meterAnnouncements: number;
      lastMeterInput: number;
      announcementTime: number;
    };
    return { count: host.meterAnnouncements, delay: host.announcementTime - host.lastMeterInput };
  });
  expect(observed.count).toBe(1);
  expect(observed.delay).toBeGreaterThanOrEqual(450);
});

test("expanded scenarios and warning pass axe with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openPage(page);
  await setNumber(page.locator("#pp-min-length"), 3);
  await setNumber(page.locator("#pp-max-length"), 3);
  await page.locator("#pw-meter summary").click();
  await page.locator("#pp-meter summary").click();
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  expect(
    await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running").length),
  ).toBe(0);
});

test("displayed bits stay below the Moderate band boundary", async ({ page }) => {
  await openPage(page);
  await page.locator("#pp-word-list").selectOption("eff-large");
  await page.locator("#pp-symbol-char").selectOption("-");
  await setNumber(page.locator("#pp-words-number"), 7);
  await setNumber(page.locator("#pp-min-length"), 6);
  await setNumber(page.locator("#pp-max-length"), 6);
  await page.locator("#pp-number").uncheck();
  await page.locator("#pp-capitalize").selectOption("random");
  await expect(page.locator("#pp-band")).toHaveText("Moderate");
  await expect(page.locator("#pp-bits")).toHaveText("79.9 bits");
  await expect(page.locator("#pp-meter-warning")).toContainText("less than 80 bits");
  await expect(page.locator("#pp-meter-status")).toContainText("Moderate, 79.9 bits.");
});

test("full default pool warning asks for words or numbers", async ({ page }) => {
  await openPage(page);
  await page.locator("#pp-symbol-char").selectOption("-");
  await page.locator("#pp-number").uncheck();
  await expect(page.locator("#pp-meter-warning")).toHaveText(
    "These settings provide less than 80 bits. Add words or turn on number separators.",
  );
  await page.locator("#pp-number").check();
  await setNumber(page.locator("#pp-words-number"), 2);
  await expect(page.locator("#pp-meter-warning")).toHaveText("These settings provide less than 80 bits. Add words.");
});

test("enabled future test config renders the estimate and assumptions", async ({ page }) => {
  let replaced = false;
  await page.route("**/assets/index-*.js", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = "enabled:!1,iterationSeconds:15,processors:1";
    replaced = body.includes(marker);
    await route.fulfill({ response, body: body.replace(marker, "enabled:!0,iterationSeconds:15,processors:1") });
  });
  await openPage(page);
  expect(replaced).toBe(true);
  await expect(page.locator("#pp-future")).toBeVisible();
  await expect(page.locator("#pp-future")).toHaveText(
    `${futureEstimate(passphraseBits(defaultPassphraseOptions))} Target: NTLM.`,
  );
  await expect(page.locator("#pp-future")).toContainText(config.meter.quantum.future.assumptions);
  await expect(page.locator("#pp-future")).toContainText("Hypothetical future fault-tolerant");
  await expect(page.locator("#pp-future")).toContainText("not demonstrated hardware performance");
  await expect(page.locator("#pp-quantum")).toHaveText(config.meter.quantum.current);
  expect(await page.locator("body").innerText()).not.toMatch(/quantum[-\s]+(?:safe|proof)/i);
});

for (const narrow of [false, true])
  test(`R13 advice omits number separators already enabled (${narrow ? "narrow" : "default"} pool)`, async ({
    page,
  }) => {
    await openPage(page);
    await setNumber(page.locator("#pp-words-number"), 3);
    if (narrow) {
      await setNumber(page.locator("#pp-min-length"), 3);
      await setNumber(page.locator("#pp-max-length"), 3);
    }
    await expect(page.locator("#pp-number")).toBeChecked();
    await expect(page.locator("#pp-meter-warning")).toBeVisible();
    await expect(page.locator("#pp-meter-warning")).toHaveText(
      narrow
        ? "This word-length range shrinks the pool to 176 words and provides less than 80 bits with these settings. Widen the range or add words."
        : "These settings provide less than 80 bits. Add words.",
    );
  });

const BITS = /^\d+(?:\.\d+)? bits$/;

test.describe("meter", () => {
  test("renders entropy for both generators on load and follows the settings", async ({ page }) => {
    await openPage(page);
    await expect(page.locator("#pw-bits")).toHaveText(BITS);
    await expect(page.locator("#pp-bits")).toHaveText(BITS);
    const before = Number.parseFloat(await page.locator("#pw-bits").innerText());
    await page.locator("#pw-uppercase").uncheck();
    await expect(page.locator("#pw-bits")).toHaveText(BITS);
    const after = Number.parseFloat(await page.locator("#pw-bits").innerText());
    expect(after).toBeLessThan(before);
    // The passphrase meter follows its own settings too: fewer words, fewer bits.
    const wordsBefore = Number.parseFloat(await page.locator("#pp-bits").innerText());
    await setNumber(page.locator("#pp-words-number"), 3);
    await expect(page.locator("#pp-bits")).toHaveText(BITS);
    const wordsAfter = Number.parseFloat(await page.locator("#pp-bits").innerText());
    expect(wordsAfter).toBeLessThan(wordsBefore);
  });

  test("clears the meter when the settings cannot generate, and restores it after", async ({ page }) => {
    await openPage(page);
    for (const id of ["pw-lowercase", "pw-uppercase", "pw-numbers", "pw-simple"])
      await page.locator(`#${id}`).uncheck();
    await expect(page.locator("#pw-notice")).toBeVisible();
    await expect(page.locator("#pw-bits")).toHaveText("");
    await expect(page.locator("#pw-band")).toContainText("Invalid settings");
    await expect(page.locator("#pw-headline")).toBeEmpty();
    await expect(page.locator("#pw-scenarios")).toBeEmpty();
    await expect(page.locator("#pw-regen")).toBeDisabled();
    await expect(page.locator("#pw-meter")).toHaveAttribute("data-level", "");
    await page.locator("#pw-lowercase").check();
    await expect(page.locator("#pw-bits")).toHaveText(BITS);
    await expect(page.locator("#pw-band")).not.toContainText("Invalid settings");
    await expect(page.locator("#pw-regen")).toBeEnabled();
  });
});

test("saved passphrase settings restore matching meter bits on reload and update afterwards", async ({ page }) => {
  await openPage(page);
  await page.locator("#pp-word-list").selectOption("eff-large");
  await page.locator("#pp-symbol-char").selectOption("-");
  const options = {
    ...defaultPassphraseOptions,
    wordList: "eff-large" as const,
    separatorSymbol: "-",
    words: 7,
    minWordLength: 6,
    maxWordLength: 6,
    number: false,
    capitalize: "random" as const,
  };
  const expectedBits = (value: typeof options) => `${(Math.floor(passphraseBits(value) * 10) / 10).toFixed(1)} bits`;
  await setNumber(page.locator("#pp-words-number"), options.words);
  await setNumber(page.locator("#pp-min-length"), options.minWordLength);
  await setNumber(page.locator("#pp-max-length"), options.maxWordLength);
  await page.locator("#pp-number").uncheck();
  await page.locator("#pp-capitalize").selectOption("random");
  await expect(page.locator("#pp-bits")).toHaveText(expectedBits(options));
  await page.locator("#save-settings").click();
  await expect(page.locator("#save-settings-status")).toContainText("Saved");
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), SETTINGS_STORAGE_KEY);
  expect(stored.settings.passphrase).toEqual(options);
  expect(Object.keys(stored.settings).sort()).toEqual(["passphrase", "password", "style", "theme"]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#pp-words-number")).toHaveValue("7");
  await expect(page.locator("#pp-min-length")).toHaveValue("6");
  await expect(page.locator("#pp-max-length")).toHaveValue("6");
  await expect(page.locator("#pp-number")).not.toBeChecked();
  await expect(page.locator("#pp-capitalize")).toHaveValue("random");
  await expect(page.locator("#pp-bits")).toHaveText("79.9 bits");
  await expect(page.locator("#pp-band")).toHaveText("Moderate");
  await expect(page.locator("#pp-meter-warning")).toBeVisible();
  await expect(page.locator("#pp-more-list li")).toHaveCount(config.extraResults);
  for (const output of await page.locator("#pp-more-list output").all())
    await expect(output).toHaveText(/^[A-Za-z][a-z]{5}(?:-[A-Za-z][a-z]{5}){6}$/);
  await page.locator("#pp-number").check();
  await expect(page.locator("#pp-bits")).toHaveText(expectedBits({ ...options, number: true }));
  await expect(page.locator("#pp-band")).toHaveText("Very strong");
  await expect(page.locator("#pp-meter-warning")).toHaveJSProperty("hidden", true);
  await expect(page.locator("#pp-more-list li")).toHaveCount(config.extraResults);
  for (const output of await page.locator("#pp-more-list output").all())
    await expect(output).toHaveText(/^[A-Za-z][a-z]{5}(?:-\d{2}-[A-Za-z][a-z]{5}){6}$/);
});
