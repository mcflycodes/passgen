import { SETTINGS_STORAGE_KEY } from "../../src/boot/storage.ts";
import { passphraseBits } from "../../src/core/entropy.ts";
import { defaultPassphraseOptions } from "../../src/core/passphrase.ts";
import { expect, test } from "./fixtures.ts";
import { openPage, resultText, setNumber } from "./helpers.ts";

test("passphrase option defaults, all positions and lengths, capitalization and exact meter", async ({ page }) => {
  await openPage(page);
  await expect(page.locator("#pp-symbol-char")).toHaveValue("random");
  await expect(page.locator("#pp-symbol-position")).toHaveValue("both");
  await expect(page.locator("#pp-number-digits")).toHaveValue("2");
  await expect(page.locator("#pp-capitalize")).toHaveValue("off");
  await expect(page.locator("#pp-unique-note")).toBeHidden();
  for (const symbolPosition of ["both", "before", "after"] as const)
    for (const numberDigits of [1, 2, 3])
      for (const capitalize of ["off", "random", "every"] as const) {
        await page.locator("#pp-symbol-position").selectOption(symbolPosition);
        await page.locator("#pp-number-digits").selectOption(String(numberDigits));
        await page.locator("#pp-capitalize").selectOption(capitalize);
        const options = { ...defaultPassphraseOptions, symbolPosition, numberDigits, capitalize };
        const words =
          capitalize === "every" ? "[A-Z][a-z]{4,8}" : capitalize === "off" ? "[a-z]{5,9}" : "[A-Za-z][a-z]{4,8}";
        const before = symbolPosition !== "after" ? "[^a-zA-Z0-9]" : "";
        const after = symbolPosition !== "before" ? "[^a-zA-Z0-9]" : "";
        expect(await resultText(page, "pp-value")).toMatch(
          new RegExp(`^${words}(?:${before}[0-9]{${numberDigits}}${after}${words}){4}$`),
        );
        await expect(page.locator("#pp-bits")).toHaveText(
          `${(Math.floor(passphraseBits(options) * 10) / 10).toFixed(1)} bits`,
        );
      }
  await page.locator("#pp-number").uncheck();
  await expect(page.locator("#pp-number-digits")).toBeDisabled();
  await expect(page.locator("#pp-symbol-position")).toBeDisabled();
  expect(await resultText(page, "pp-value")).toMatch(/^[A-Z][a-z]+(?:[^a-zA-Z0-9][A-Z][a-z]+){4}$/);
  await page.locator("#pp-number").check();
  await page.locator("#pp-symbol").uncheck();
  await expect(page.locator("#pp-symbol-position")).toBeDisabled();
});

test("unique repeat note follows actual slots and generation remains available", async ({ page }) => {
  await openPage(page);
  await page.locator("#pp-symbol-char").selectOption("random-unique");
  await setNumber(page.locator("#pp-words-number"), 7);
  await expect(page.locator("#pp-unique-note")).toBeHidden();
  await setNumber(page.locator("#pp-words-number"), 8);
  await expect(page.locator("#pp-unique-note")).toBeVisible();
  await expect(page.locator("#pp-unique-note")).toContainText("spread evenly");
  await expect(page.locator("#pp-regen")).toBeEnabled();
  await expect(page.locator("#pp-notice")).toBeHidden();
  await page.locator("#pp-symbol-position").selectOption("before");
  await expect(page.locator("#pp-unique-note")).toBeHidden();
  await page.locator("#pp-symbol-position").selectOption("both");
  await page.locator("#pp-number").uncheck();
  await expect(page.locator("#pp-unique-note")).toBeHidden();
  await page.locator("#pp-number").check();
  await page.locator("#pp-symbol-char").selectOption("random");
  await expect(page.locator("#pp-unique-note")).toBeHidden();
});

test("new options save, restore and reset; old v2 records are discarded and cleaned", async ({ page }) => {
  await openPage(page);
  await page.evaluate(() => localStorage.setItem("passgen:settings:v2", '{"version":2,"settings":{}}'));
  await page.reload();
  await expect(page.locator("#pp-symbol-position")).toHaveValue("both");
  await expect(page.locator("#pp-number-digits")).toHaveValue("2");
  await expect(page.locator("#pp-capitalize")).toHaveValue("off");
  await page.locator("#pp-symbol-position").selectOption("after");
  await page.locator("#pp-number-digits").selectOption("1");
  await page.locator("#pp-capitalize").selectOption("every");
  await page.locator("#save-settings").click();
  expect(await page.evaluate(() => localStorage.getItem("passgen:settings:v2"))).toBeNull();
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) as string), SETTINGS_STORAGE_KEY);
  expect(saved.version).toBe(4);
  expect(saved.settings.passphrase).toMatchObject({ symbolPosition: "after", numberDigits: 1, capitalize: "every" });
  await page.reload();
  await expect(page.locator("#pp-symbol-position")).toHaveValue("after");
  await expect(page.locator("#pp-number-digits")).toHaveValue("1");
  await expect(page.locator("#pp-capitalize")).toHaveValue("every");
  expect(await resultText(page, "pp-value")).toMatch(/^[A-Z][a-z]+(?:[0-9][^a-zA-Z0-9][A-Z][a-z]+){4}$/);
  await page.locator("#reset-settings").click();
  await expect(page.locator("#pp-symbol-position")).toHaveValue("both");
  await expect(page.locator("#pp-number-digits")).toHaveValue("2");
  await expect(page.locator("#pp-capitalize")).toHaveValue("off");
  await expect(page.locator("#pp-symbol-char")).toHaveValue("random");
  expect(await page.evaluate((key) => localStorage.getItem(key), SETTINGS_STORAGE_KEY)).toBeNull();
});

test("separator look-alikes filter the dropdown and output, fall back, save and reset", async ({ page }) => {
  await openPage(page);
  const checkbox = page.locator("#pp-lookalikes");
  const dropdown = page.locator("#pp-symbol-char");
  await expect(checkbox).not.toBeChecked();
  await dropdown.selectOption("!");
  await checkbox.check();
  await expect(dropdown).toHaveValue("-");
  await page.locator("#save-settings").click();
  const fixed = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) as string), SETTINGS_STORAGE_KEY);
  expect(fixed.settings.passphrase).toMatchObject({ excludeLookAlikes: true, separatorSymbol: "-" });
  await page.reload();
  await expect(checkbox).toBeChecked();
  await expect(dropdown).toHaveValue("-");
  expect(
    await dropdown.locator("option").evaluateAll((options) => options.map((option) => option.getAttribute("value"))),
  ).toEqual([..."@#$^*-?", "random", "random-unique"]);
  for (const mode of ["-", "random", "random-unique"]) {
    await dropdown.selectOption(mode);
    for (const position of ["both", "before", "after"]) {
      await page.locator("#pp-symbol-position").selectOption(position);
      for (let i = 0; i < 5; i++) {
        await page.locator("#pp-regen").click();
        const value = await resultText(page, "pp-value");
        expect(value).not.toMatch(/[!()._]/);
        expect(value.match(/[^a-zA-Z0-9]/g)?.every((symbol) => "@#$^*-?".includes(symbol))).toBe(true);
      }
    }
  }
  await dropdown.selectOption("random-unique");
  await page.locator("#pp-symbol-position").selectOption("both");
  await expect(page.locator("#pp-unique-note")).toBeVisible();
  await page.evaluate(() => localStorage.setItem("passgen:settings:v3", '{"version":3,"settings":{}}'));
  await page.locator("#save-settings").click();
  expect(await page.evaluate(() => localStorage.getItem("passgen:settings:v3"))).toBeNull();
  await page.reload();
  await expect(checkbox).toBeChecked();
  await expect(dropdown.locator('option[value="!"]')).toHaveCount(0);
  await checkbox.uncheck();
  await expect(dropdown.locator('option[value="!"]')).toHaveCount(1);
  await checkbox.check();
  await page.locator("#reset-settings").click();
  await expect(checkbox).not.toBeChecked();
  await expect(dropdown).toHaveValue("random");
  await expect(dropdown.locator('option[value="!"]')).toHaveCount(1);
});
