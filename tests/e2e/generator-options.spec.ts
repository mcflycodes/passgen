import { config } from "../../src/config/validate.ts";
import { expect, test } from "./fixtures.ts";
import { openPage, resultText, setNumber } from "./helpers.ts";

const symbols = config.password.characters.simple + config.password.characters.complex;
for (const { id: style } of config.style.offered) {
  test(`new generator controls work by keyboard in ${style}`, async ({ page }) => {
    await openPage(page);
    await page.locator("#style").selectOption(style);
    const firstRule = page.getByRole("checkbox", { name: "Don't start with a symbol" });
    await expect(firstRule).toBeChecked();
    await expect(firstRule).toHaveAccessibleDescription(/Skipped if/);
    expect(symbols.includes((await resultText(page, "pw-value"))[0] as string)).toBe(false);
    await firstRule.focus();
    await page.keyboard.press("Space");
    await expect(firstRule).not.toBeChecked();
    await page.keyboard.press("Space");
    await expect(firstRule).toBeChecked();
    const select = page.locator("#pp-symbol-char");
    await expect(select).toHaveValue("random");
    await expect(select).toHaveAccessibleName("Symbol");
    await expect(select).toHaveAccessibleDescription(/Random picks each symbol/);
    for (const mode of ["random", "random-unique"]) {
      await select.selectOption(mode);
      await select.focus();
      await page.keyboard.press("Tab");
      expect(await select.evaluate((el) => el === document.activeElement)).toBe(false);
      await setNumber(page.locator("#pp-words-number"), 12);
      for (const number of [true, false]) {
        await page.locator("#pp-number").setChecked(number);
        const value = await resultText(page, "pp-value");
        const punctuation = [...value].filter((char) => config.password.characters.simple.includes(char));
        expect(punctuation).toHaveLength(number ? 22 : 11);
        if (mode === "random-unique") {
          expect(new Set(punctuation.slice(0, 12)).size).toBe(number ? 12 : 11);
          if (number)
            for (let i = 0; i < punctuation.length; i += 2) expect(punctuation[i]).not.toBe(punctuation[i + 1]);
        }
        await expect(page.locator("#pp-notice")).toBeHidden();
        await expect(page.locator("#pp-copy")).toBeEnabled();
      }
    }
    await page.locator("#pp-symbol").uncheck();
    await expect(select).toBeDisabled();
    expect(await resultText(page, "pp-value")).toMatch(/^[a-z]+$/);
  });
}

test("first-symbol rule shows a note for only symbols and for limits forcing only symbols, then recovers", async ({
  page,
}) => {
  await openPage(page);
  const notice = page.locator("#pw-notice");
  for (const type of ["lowercase", "uppercase", "numbers"]) await page.locator(`#pw-${type}`).uncheck();
  await expect(notice).toHaveText("Don't start with a symbol is skipped: these settings require only symbols.");
  await expect(page.locator("#pw-copy")).toBeEnabled();
  await expect(page.locator("#pw-regen")).toBeEnabled();
  await expect(page.locator("#pw-bits")).not.toHaveText("");
  expect([...(await resultText(page, "pw-value"))].every((char) => symbols.includes(char))).toBe(true);
  await page.locator("#pw-lowercase").check();
  await setNumber(page.locator("#pw-lowercase-min"), 0);
  await setNumber(page.locator("#pw-symbols-min"), 20);
  await expect(notice).toBeVisible();
  await expect(page.locator("#pw-copy")).toBeEnabled();
  await page.locator("#pw-no-start-symbol").uncheck();
  await expect(notice).toBeHidden();
  await page.locator("#pw-no-start-symbol").check();
  await expect(notice).toBeVisible();
  await setNumber(page.locator("#pw-symbols-min"), 1);
  await expect(notice).toBeHidden();
  expect(symbols.includes((await resultText(page, "pw-value"))[0] as string)).toBe(false);
});
