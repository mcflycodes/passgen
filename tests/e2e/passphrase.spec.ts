// The passphrase generator's controls (R12 to R14a, R21, R22).

import { config } from "../../src/config/validate.ts";
import { expect, test } from "./fixtures.ts";
import { openPage, resultText, setNumber, setRange } from "./helpers.ts";

const sep = "-";
const escaped = sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const defaultPattern = /^[a-z]{5,9}(?:[^a-z0-9]\d{2}[^a-z0-9][a-z]{5,9}){4}$/;

test.describe("passphrase", () => {
  test("appears on load with the defaults: five words of 5 to 9 letters, number and symbol separators", async ({
    page,
  }) => {
    await openPage(page);
    expect(await resultText(page, "pp-value")).toMatch(defaultPattern);
    await expect(page.locator("#pp-value")).toHaveAttribute("data-generated", "");
    await expect(page.locator("#pp-copy")).toBeEnabled();
  });

  test("the word count follows the slider and the exact field", async ({ page }) => {
    await openPage(page);
    await page.locator("#pp-symbol-char").selectOption("-");
    await setRange(page.locator("#pp-words"), 3);
    await expect(page.locator("#pp-words-number")).toHaveValue("3");
    expect((await resultText(page, "pp-value")).split(sep)).toHaveLength(5); // w-NN-w-NN-w
    await setNumber(page.locator("#pp-words-number"), 12);
    expect((await resultText(page, "pp-value")).split(sep)).toHaveLength(23);
    await setNumber(page.locator("#pp-words-number"), 1);
    await expect(page.locator("#pp-words-number")).toHaveValue(String(config.passphrase.words.min));
  });

  test("separators: number only, symbol only, neither, and the symbol from the dropdown (R14)", async ({ page }) => {
    await openPage(page);
    await page.locator("#pp-symbol").uncheck();
    await expect(page.locator("#pp-symbol-char")).toBeDisabled();
    expect(await resultText(page, "pp-value")).toMatch(/^[a-z]+(?:\d{2}[a-z]+){4}$/);
    await page.locator("#pp-symbol").check();
    await page.locator("#pp-number").uncheck();
    await page.locator("#pp-symbol-char").selectOption("-");
    expect(await resultText(page, "pp-value")).toMatch(new RegExp(`^[a-z]+(?:${escaped}[a-z]+){4}$`));
    await page.locator("#pp-symbol-char").selectOption("_");
    expect(await resultText(page, "pp-value")).toMatch(/^[a-z]+(?:_[a-z]+){4}$/);
    await page.locator("#pp-number").check();
    expect(await resultText(page, "pp-value")).toMatch(/^[a-z]+(?:_\d{2}_[a-z]+){4}$/);
    await page.locator("#pp-symbol").uncheck();
    await page.locator("#pp-number").uncheck();
    expect(await resultText(page, "pp-value")).toMatch(/^[a-z]{25,45}$/);
  });

  test("capitalize uppercases first letters at random (R14a)", async ({ page }) => {
    await openPage(page);
    await page.locator("#pp-capitalize").selectOption("random");
    const seen: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      seen.push(await resultText(page, "pp-value"));
      await page.locator("#pp-regen").click();
    }
    const words = seen.flatMap((v) => v.split(/[^a-zA-Z]+/));
    expect(words.every((w) => /^[A-Za-z][a-z]*$/.test(w))).toBe(true);
    expect(words.some((w) => /^[A-Z]/.test(w))).toBe(true);
    expect(words.some((w) => /^[a-z]/.test(w))).toBe(true);
  });

  test("word length limits apply, and the two fields never cross (R13)", async ({ page }) => {
    await openPage(page);
    await setNumber(page.locator("#pp-min-length"), 7);
    await setNumber(page.locator("#pp-max-length"), 7);
    for (let i = 0; i < 3; i += 1) {
      const words = (await resultText(page, "pp-value")).split(/[^a-zA-Z]+/);
      expect(words).toHaveLength(5);
      for (const w of words) expect(w).toHaveLength(7);
      await page.locator("#pp-regen").click();
    }
    await setNumber(page.locator("#pp-max-length"), 4);
    await expect(page.locator("#pp-min-length")).toHaveValue("4");
    await setNumber(page.locator("#pp-min-length"), 9);
    await expect(page.locator("#pp-max-length")).toHaveValue("9");
    await setNumber(page.locator("#pp-min-length"), 1);
    await expect(page.locator("#pp-min-length")).toHaveValue(String(config.passphrase.wordLength.min));
    await setNumber(page.locator("#pp-max-length"), 99);
    await expect(page.locator("#pp-max-length")).toHaveValue(String(config.passphrase.wordLength.max));
    await expect(page.locator("#pp-notice")).toBeHidden();
  });

  test("Regenerate and Copy work without a popup", async ({ page, context }) => {
    await openPage(page);
    const first = await resultText(page, "pp-value");
    await page.locator("#pp-regen").click();
    expect(await resultText(page, "pp-value")).not.toBe(first);
    try {
      await context.grantPermissions(["clipboard-write"]);
    } catch {
      // Not every engine takes clipboard permissions; the feedback still shows.
    }
    const copy = page.locator("#pp-copy");
    await copy.click();
    await expect(copy).toHaveText(/^(Copied|Copy failed)$/);
    if (test.info().project.name.includes("chrom")) {
      await expect(copy).toHaveText("Copied");
    }
    await expect(copy).toHaveText("Copy", { timeout: 5000 });
  });
});
