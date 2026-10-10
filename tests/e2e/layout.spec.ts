// Page shell and layout (R1 to R3, R4d, R5): two columns on desktop, one on
// narrow widths, the configured page text, and a password above the fold
// with no click.

import { config } from "../../src/config/validate.ts";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, openPage, STYLES } from "./helpers.ts";

test.describe("page shell", () => {
  test("shows the PassGen name, the configured tagline and intro", async ({ page }) => {
    await openPage(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("PassGen");
    const width = page.viewportSize()?.width ?? 0;
    const tagline = page.locator(".tagline");
    await expect(tagline).toHaveText(config.text.tagline);
    if (width >= 1280) await expect(tagline).toBeVisible();
    else await expect(tagline).toBeHidden();
    await expect(page.locator("#intro-headline")).toHaveText(config.text.intro.headline);
    await expect(page.locator(".lede")).toHaveText(config.text.intro.text);
  });

  test("has both generators with every control, in two columns on desktop and one on mobile", async ({ page }) => {
    await openPage(page);
    const password = await page.locator("#password").boundingBox();
    const passphrase = await page.locator("#passphrase").boundingBox();
    if (!password || !passphrase) throw new Error("generator panels not rendered");
    const width = page.viewportSize()?.width ?? 0;
    if (width > 900) {
      expect(Math.abs(password.y - passphrase.y)).toBeLessThan(2);
      expect(password.x + password.width).toBeLessThanOrEqual(passphrase.x + 1);
    } else {
      expect(passphrase.y).toBeGreaterThanOrEqual(password.y + password.height - 1);
      expect(Math.abs(password.x - passphrase.x)).toBeLessThan(2);
    }
    for (const id of [
      "pw-length",
      "pw-length-number",
      "pw-lowercase",
      "pw-uppercase",
      "pw-numbers",
      "pw-simple",
      "pw-complex",
      "pw-lookalikes",
      "pw-lowercase-min",
      "pw-symbols-max",
      "pw-copy",
      "pw-regen",
      "pp-words",
      "pp-words-number",
      "pp-min-length",
      "pp-max-length",
      "pp-number",
      "pp-symbol",
      "pp-symbol-char",
      "pp-symbol-position",
      "pp-number-digits",
      "pp-capitalize",
      "pp-copy",
      "pp-regen",
      "theme-system",
      "theme-light",
      "theme-dark",
      "style",
    ]) {
      await expect(page.locator(`#${id}`), id).toBeAttached();
    }
    // Touch-friendly controls (R3): the primary buttons are at least 40px tall.
    for (const id of ["pw-copy", "pp-copy", "pw-regen"]) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(Math.round(box?.height ?? 0), id).toBeGreaterThanOrEqual(40);
    }
  });

  test("a password is on screen as soon as the page loads, with no click", async ({ page }) => {
    await openPage(page);
    const value = page.locator("#pw-value");
    await expect(value).toHaveAttribute("data-generated", "");
    await expect(value).not.toHaveText("");
    const box = await value.boundingBox();
    const height = page.viewportSize()?.height ?? 0;
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(height);
    await expect(page.locator("#pp-value")).not.toHaveText("");
  });

  test("the style options and the separator symbols come from the configuration", async ({ page }) => {
    await openPage(page);
    const styles = await page
      .locator("#style option")
      .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    expect(styles).toEqual(config.style.offered.map((s) => s.id));
    await expect(page.locator("#style")).toHaveValue(config.style.default);
    const symbols = await page
      .locator("#pp-symbol-char option")
      .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    expect(symbols).toEqual([...config.password.characters.simple, "random", "random-unique"]);
    await expect(page.locator("#pp-symbol-char")).toHaveValue(config.passphrase.separator.defaultSymbol);
    await expect(page.locator("#pw-simple-chars")).toHaveText([...config.password.characters.simple].join(" "));
    await expect(page.locator("#pw-lookalikes-chars")).toHaveText([...config.password.lookAlikes].join(" "));
    await expect(page.locator("#pw-lowercase-chars")).toHaveText("a–z");
  });
});

for (const style of STYLES) {
  test(`intro paragraph fits wide screens and wraps on mobile / ${style}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openPage(page);
    await chooseStyle(page, style);
    const paragraph = page.locator(".lede");
    const lines = () =>
      paragraph.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      });
    await expect(paragraph).toHaveText(config.text.intro.text);
    expect(await lines()).toBe(1);
    await page.setViewportSize({ width: 393, height: 852 });
    expect(await lines()).toBeGreaterThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(393);
  });

  test(`intro can stay disabled with the wider paragraph cap / ${style}`, async ({ page }) => {
    await page.route("**/", async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/<section class="intro"[^>]*>[\s\S]*?<\/section>/, "");
      await route.fulfill({ response, body });
    });
    await openPage(page);
    await chooseStyle(page, style);
    await expect(page.locator(".intro")).toHaveCount(0);
    await expect(page.locator("#pw-value")).not.toBeEmpty();
    await expect(page.locator("#pp-value")).not.toBeEmpty();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()?.width);
  });
}
