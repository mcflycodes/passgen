// Theme and style (R4, R4a, N2): every offered style in System (light and
// dark), Light and Dark, with axe, no flash before the first paint, no
// console or CSP errors and no request to another origin.

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, chooseTheme, isDark, openPage, pageBackground, STYLES } from "./helpers.ts";
import { ORIGINS } from "./servers.ts";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.describe("theme before first paint", () => {
  test("the boot script sets the theme and style before any stylesheet or the body exists", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __firstPaintState?: unknown };
      // Init scripts can run before <html> exists, so watch the document.
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
    await openPage(page);
    const state = await page.evaluate(() => (window as unknown as { __firstPaintState?: unknown }).__firstPaintState);
    expect(state).toEqual({ theme: "system", style: "calm", stylesheets: 0, hasBody: false, readyState: "loading" });
    const head = await page.evaluate(() =>
      [...document.head.children].map((el) => ({
        tag: el.tagName.toLowerCase(),
        rel: el.getAttribute("rel"),
        type: el.getAttribute("type"),
        defer: el.hasAttribute("defer"),
        async: el.hasAttribute("async"),
      })),
    );
    const boot = head.findIndex((el) => el.tag === "script" && el.type === null);
    const stylesheet = head.findIndex((el) => el.tag === "link" && el.rel === "stylesheet");
    const module = head.findIndex((el) => el.tag === "script" && el.type === "module");
    expect(boot).toBeGreaterThan(-1);
    expect(head[boot]).toMatchObject({ defer: false, async: false });
    expect(boot).toBeLessThan(stylesheet);
    expect(boot).toBeLessThan(module);
  });

  test("System follows the operating system live; Light and Dark override it", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openPage(page);
    await expect(page.locator("#theme-system")).toBeChecked();
    // The page's COOP header gives it a fresh browsing context in some
    // engines, which drops an emulation set before navigation: set it again.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(async () => isDark(await pageBackground(page))).toBe(true);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(async () => isDark(await pageBackground(page))).toBe(false);
    await chooseTheme(page, "dark");
    expect(isDark(await pageBackground(page))).toBe(true);
    await page.emulateMedia({ colorScheme: "dark" });
    await chooseTheme(page, "light");
    await expect.poll(async () => isDark(await pageBackground(page))).toBe(false);
    await chooseTheme(page, "system");
    await expect.poll(async () => isDark(await pageBackground(page))).toBe(true);
  });
});

for (const style of STYLES) {
  test.describe(`style ${style}`, () => {
    for (const [label, theme, scheme] of [
      ["system, light OS", "system", "light"],
      ["system, dark OS", "system", "dark"],
      ["light", "light", "dark"],
      ["dark", "dark", "light"],
    ] as const) {
      test(`${label}: renders with AA contrast, no errors and no foreign requests`, async ({ page, watched }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openPage(page);
        await page.emulateMedia({ colorScheme: scheme }); // again: see the test above
        await chooseStyle(page, style);
        await chooseTheme(page, theme);
        const dark = theme === "dark" || (theme === "system" && scheme === "dark");
        await expect.poll(async () => isDark(await pageBackground(page))).toBe(dark);
        // The style's tokens are in effect: its accent paints the primary button.
        const accent = await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--accent"),
        );
        expect(accent.trim()).not.toBe("");
        const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect(results.violations).toEqual([]);
        await page.waitForLoadState("networkidle");
        expect(watched.problems).toEqual([]);
        expect(await watched.violations()).toEqual([]);
        for (const url of watched.requests) expect(new URL(url).origin).toBe(ORIGINS.root);
      });
    }

    test("keeps the same markup: only tokens change", async ({ page }) => {
      await openPage(page);
      const before = await page.evaluate(() => document.body.querySelectorAll("*").length);
      await chooseStyle(page, style);
      expect(await page.evaluate(() => document.body.querySelectorAll("*").length)).toBe(before);
      await expect(page.locator("#pw-value")).not.toHaveText("");
    });
  });
}

for (const style of STYLES) {
  for (const theme of ["light", "dark"] as const) {
    test(`header typography matches the tagline: ${style}/${theme}`, async ({ page }) => {
      await openPage(page);
      await chooseStyle(page, style);
      await chooseTheme(page, theme);
      const typography = await page
        .locator(".tagline, .style-label, #style, .theme-control label")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const css = getComputedStyle(element);
            return {
              family: css.fontFamily,
              weight: css.fontWeight,
              transform: css.textTransform,
              spacing: css.letterSpacing,
            };
          }),
        );
      expect(typography).toHaveLength(6);
      for (const control of typography.slice(1)) expect(control).toEqual(typography[0]);
    });
  }
}
