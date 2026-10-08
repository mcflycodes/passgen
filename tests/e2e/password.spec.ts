// The password generator's controls (R5 to R11b, R21, R22): output follows
// every control, invalid settings disable generation with a message, and the
// R11b adjustment shows live in the Max fields.

import { config } from "../../src/config/validate.ts";
import { expect, test } from "./fixtures.ts";
import { openPage, resultText, setNumber, setRange } from "./helpers.ts";

const chars = config.password.characters;
const classOf = (c: string) =>
  chars.lowercase.includes(c)
    ? "lowercase"
    : chars.uppercase.includes(c)
      ? "uppercase"
      : chars.numbers.includes(c)
        ? "numbers"
        : chars.simple.includes(c) || chars.complex.includes(c)
          ? "symbols"
          : "other";
const count = (value: string, type: string) => [...value].filter((c) => classOf(c) === type).length;

test.describe("password", () => {
  test("appears on load with the defaults: 20 characters, one of each type, nothing else", async ({ page }) => {
    await openPage(page);
    const value = await resultText(page, "pw-value");
    expect(value).toHaveLength(config.password.length.default);
    for (const type of ["lowercase", "uppercase", "numbers", "symbols"])
      expect(count(value, type), type).toBeGreaterThan(0);
    expect(count(value, "other")).toBe(0);
    await expect(page.locator("#pw-notice")).toBeHidden();
    await expect(page.locator("#pw-copy")).toBeEnabled();
  });

  test("the length slider and the exact field change the length together", async ({ page }) => {
    await openPage(page);
    await setRange(page.locator("#pw-length"), 40);
    await expect(page.locator("#pw-length-number")).toHaveValue("40");
    expect(await resultText(page, "pw-value")).toHaveLength(40);
    await setNumber(page.locator("#pw-length-number"), 7);
    await expect(page.locator("#pw-length")).toHaveValue("7");
    expect(await resultText(page, "pw-value")).toHaveLength(7);
    // Out-of-range entry is clamped to the bounds (R6).
    await setNumber(page.locator("#pw-length-number"), 999);
    await expect(page.locator("#pw-length-number")).toHaveValue(String(config.password.length.max));
    expect(await resultText(page, "pw-value")).toHaveLength(config.password.length.max);
    // The Max fields follow the length while they mean "no limit" (R11a).
    await expect(page.locator("#pw-lowercase-max")).toHaveValue(String(config.password.length.max));
  });

  test("Regenerate gives a new value and Copy shows feedback on the button", async ({ page, context }) => {
    await openPage(page);
    const first = await resultText(page, "pw-value");
    await page.locator("#pw-regen").click();
    expect(await resultText(page, "pw-value")).not.toBe(first);
    try {
      await context.grantPermissions(["clipboard-write"]);
    } catch {
      // Not every engine takes clipboard permissions; the feedback still shows.
    }
    const copy = page.locator("#pw-copy");
    await copy.click();
    await expect(copy).toHaveText(/^(Copied|Copy failed)$/);
    if (test.info().project.name.includes("chrom")) {
      await expect(copy).toHaveText("Copied");
    }
    await expect(copy).toHaveText("Copy", { timeout: 5000 });
    expect(await page.locator("[role=dialog], dialog[open]").count()).toBe(0);
  });

  test("character types change the output and the symbol rule holds", async ({ page }) => {
    await openPage(page);
    await page.locator("#pw-uppercase").uncheck();
    await page.locator("#pw-numbers").uncheck();
    await page.locator("#pw-complex").uncheck();
    let value = await resultText(page, "pw-value");
    expect(count(value, "uppercase")).toBe(0);
    expect(count(value, "numbers")).toBe(0);
    expect([...value].every((c) => chars.lowercase.includes(c) || chars.simple.includes(c))).toBe(true);
    // Unchecking Simple while Complex is on turns Complex off; checking Complex turns Simple on (R8).
    await page.locator("#pw-complex").check();
    await page.locator("#pw-simple").uncheck();
    await expect(page.locator("#pw-complex")).not.toBeChecked();
    await page.locator("#pw-complex").check();
    await expect(page.locator("#pw-simple")).toBeChecked();
    value = await resultText(page, "pw-value");
    expect(count(value, "symbols")).toBeGreaterThan(0);
    // Count fields follow the checkbox (disabled state).
    await expect(page.locator("#pw-uppercase-min")).toBeDisabled();
    await expect(page.locator("#pw-symbols-min")).toBeEnabled();
    await page.locator("#pw-uppercase").check();
    await expect(page.locator("#pw-uppercase-min")).toBeEnabled();
  });

  test("with every type off, generation is disabled with a message (R9)", async ({ page }) => {
    await openPage(page);
    for (const id of ["pw-lowercase", "pw-uppercase", "pw-numbers", "pw-simple"])
      await page.locator(`#${id}`).uncheck();
    await expect(page.locator("#pw-complex")).not.toBeChecked();
    await expect(page.locator("#pw-value")).toHaveText("");
    await expect(page.locator("#pw-notice")).toBeVisible();
    await expect(page.locator("#pw-notice")).toContainText("Select at least one character type");
    await expect(page.locator("#pw-copy")).toBeDisabled();
    await expect(page.locator("#pw-regen")).toBeDisabled();
    await page.locator("#pw-lowercase").check();
    await expect(page.locator("#pw-notice")).toBeHidden();
    await expect(page.locator("#pw-value")).not.toHaveText("");
  });

  test("no look-alike characters removes exactly the configured set (R7a)", async ({ page }) => {
    await openPage(page);
    await page.locator("#pw-lookalikes").check();
    await setRange(page.locator("#pw-length"), 128);
    for (let i = 0; i < 5; i += 1) {
      const value = await resultText(page, "pw-value");
      for (const c of config.password.lookAlikes) expect(value, `no ${c}`).not.toContain(c);
      await page.locator("#pw-regen").click();
    }
    await page.locator("#pw-lookalikes").uncheck();
    const values: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      values.push(await resultText(page, "pw-value"));
      await page.locator("#pw-regen").click();
    }
    expect(values.join("")).toMatch(/[lIO01|`']/);
  });

  test("Min and Max limits are kept, and a short Max total raises lowercase Max live (R11a, R11b)", async ({
    page,
  }) => {
    await openPage(page);
    await setNumber(page.locator("#pw-uppercase-max"), 2);
    await setNumber(page.locator("#pw-numbers-max"), 2);
    await setNumber(page.locator("#pw-symbols-max"), 2);
    await expect(page.locator("#pw-lowercase-max")).toHaveValue("20");
    // Typing a Max the other limits cannot cover raises it at once, while the
    // field still has focus, so the field always shows the value the visible
    // output was generated with (security review finding 4).
    const lowerMax = page.locator("#pw-lowercase-max");
    await lowerMax.focus();
    await lowerMax.fill("5");
    await expect(lowerMax).toHaveValue("14");
    await expect(lowerMax).toBeFocused();
    await expect(page.locator("#pw-notice")).toBeHidden();
    await expect(page.locator("#pw-copy")).toBeEnabled();
    expect(count(await resultText(page, "pw-value"), "lowercase")).toBeGreaterThanOrEqual(14);
    for (let i = 0; i < 5; i += 1) {
      const value = await resultText(page, "pw-value");
      expect(value).toHaveLength(20);
      expect(count(value, "uppercase")).toBeLessThanOrEqual(2);
      expect(count(value, "numbers")).toBeLessThanOrEqual(2);
      expect(count(value, "symbols")).toBeLessThanOrEqual(2);
      expect(count(value, "lowercase")).toBeGreaterThanOrEqual(14);
      await page.locator("#pw-regen").click();
    }
    // With lowercase off, the first selected type (uppercase) is raised instead.
    await page.locator("#pw-lowercase").uncheck();
    await expect(page.locator("#pw-uppercase-max")).toHaveValue("16");
    await expect(page.locator("#pw-notice")).toBeHidden();
    // A Min count is honoured.
    await page.locator("#pw-lowercase").check();
    await setNumber(page.locator("#pw-numbers-min"), 2);
    for (let i = 0; i < 5; i += 1) {
      expect(count(await resultText(page, "pw-value"), "numbers")).toBe(2);
      await page.locator("#pw-regen").click();
    }
  });

  test("the count fields always match the settings behind the visible output", async ({ page }) => {
    await openPage(page);
    const read = async () => {
      const fields: Record<string, string> = {};
      for (const type of ["lowercase", "uppercase", "numbers", "symbols"]) {
        for (const f of ["min", "max"]) fields[`${type}-${f}`] = await page.locator(`#pw-${type}-${f}`).inputValue();
      }
      return fields;
    };
    // While a field is focused and being typed into, every field already shows the applied value.
    const numbersMax = page.locator("#pw-numbers-max");
    await numbersMax.focus();
    await numbersMax.fill("1");
    await expect(numbersMax).toHaveValue("1");
    for (let i = 0; i < 5; i += 1) {
      const value = await resultText(page, "pw-value");
      expect(count(value, "numbers")).toBeLessThanOrEqual(1);
      await page.locator("#pw-regen").click();
    }
    const fields = await read();
    expect(fields["numbers-max"]).toBe("1");
    expect(fields["lowercase-max"]).toBe("20");
    // A Max that cannot hold the length raises lowercase Max live, in its own field, and the output follows.
    await page.locator("#pw-uppercase-max").focus();
    await page.locator("#pw-uppercase-max").fill("1");
    await page.locator("#pw-symbols-max").focus();
    await page.locator("#pw-symbols-max").fill("1");
    const lowerMax = page.locator("#pw-lowercase-max");
    await lowerMax.focus();
    await lowerMax.fill("3");
    await expect(lowerMax).toHaveValue("17");
    const value = await resultText(page, "pw-value");
    expect(count(value, "lowercase")).toBeGreaterThanOrEqual(17);
    expect(count(value, "uppercase")).toBeLessThanOrEqual(1);
  });

  test("impossible limits stop generation with a message (R11, R11b)", async ({ page }) => {
    await openPage(page);
    const notice = page.locator("#pw-notice");
    // Min counts adding up to more than the length.
    await setNumber(page.locator("#pw-lowercase-min"), 10);
    await setNumber(page.locator("#pw-uppercase-min"), 11);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("cannot hold the 23 characters");
    await expect(page.locator("#pw-value")).toHaveText("");
    await expect(page.locator("#pw-copy")).toBeDisabled();
    await expect(page.locator("#pw-lowercase-min")).toHaveAttribute("aria-invalid", "true");
    await setNumber(page.locator("#pw-uppercase-min"), 1);
    await expect(notice).toBeHidden();
    await expect(page.locator("#pw-value")).not.toHaveText("");
    // A Min above its Max.
    await setNumber(page.locator("#pw-numbers-max"), 3);
    await setNumber(page.locator("#pw-numbers-min"), 4);
    await expect(notice).toContainText("Numbers: Min 4 is above Max 3");
    await expect(page.locator("#pw-numbers-min")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#pw-regen")).toBeDisabled();
    // Not a whole number.
    await setNumber(page.locator("#pw-numbers-min"), "x");
    await expect(notice).toContainText("Numbers: Min must be a whole number from 0 to 20");
    await setNumber(page.locator("#pw-numbers-min"), 1);
    await expect(notice).toBeHidden();
    // Length below the number of selected types, through the Min total.
    await setNumber(page.locator("#pw-length-number"), 4);
    await setNumber(page.locator("#pw-lowercase-min"), 2);
    await expect(notice).toContainText("A 4-character password cannot hold the 5 characters");
  });
});
