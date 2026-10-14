// v1.5.1 bottom of the page. From 1200px three columns: the privacy line,
// the meta line (version · Apache-2.0 · Credits · GitHub) and the settings
// code box, the first two centred against the box. From 901 to 1199px two:
// the privacy and meta lines stacked on the left, the box on the right. Up to
// 900px everything stacks in the DOM order, which is also the reading and
// keyboard order at every width: privacy, meta, settings code. The settings
// code is always open, with no Get button; there is no Save or Reset here.

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, chooseTheme, openPage, STYLES } from "./helpers.ts";

type Box = { left: number; right: number; top: number; bottom: number; centre: number };

function footerGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null): Box => {
      if (!el) throw new Error("Missing footer element");
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, centre: r.top + r.height / 2 };
    };
    const metaItems = [...document.querySelectorAll(".foot .foot-meta")].map((el) => box(el));
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      content: box(document.querySelector(".generators")),
      footer: box(document.querySelector(".foot")),
      privacy: box(document.querySelector(".foot-privacy")),
      meta: {
        left: Math.min(...metaItems.map((b) => b.left)),
        right: Math.max(...metaItems.map((b) => b.right)),
        top: Math.min(...metaItems.map((b) => b.top)),
        bottom: Math.max(...metaItems.map((b) => b.bottom)),
        centre: 0,
      },
      metaItems,
      code: box(document.querySelector(".settings-code")),
      codeValue: box(document.getElementById("settings-code-value")),
      codeInput: box(document.getElementById("settings-code-input")),
    };
  });
}

test.describe("footer layout", () => {
  for (const width of [1440, 1920, 1200]) {
    for (const style of STYLES) {
      test(`three columns, privacy and meta centred on the settings code: ${style}/${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openPage(page);
        await chooseStyle(page, style);
        for (const theme of ["light", "dark"] as const) {
          await chooseTheme(page, theme);
          const g = await footerGeometry(page);
          expect(g.overflow).toBeLessThanOrEqual(0);
          // Left to right, with the footer's edges at the content's edges.
          expect(Math.abs(g.privacy.left - g.content.left)).toBeLessThanOrEqual(1);
          expect(g.meta.left).toBeGreaterThan(g.privacy.right);
          expect(g.code.left).toBeGreaterThan(g.meta.right);
          expect(Math.abs(g.code.right - g.content.right)).toBeLessThanOrEqual(1);
          // The meta line is one row; each part and the privacy line are centred on the box.
          expect(Math.abs(g.privacy.centre - g.code.centre), "privacy centred").toBeLessThanOrEqual(2);
          for (const item of g.metaItems)
            expect(Math.abs(item.centre - g.code.centre), "meta centred").toBeLessThanOrEqual(2);
          // The code fields keep room for a code on a line or two.
          expect(g.codeValue.right - g.codeValue.left).toBeGreaterThanOrEqual(width >= 1440 ? 300 : 200);
          expect(g.codeInput.right - g.codeInput.left).toBeGreaterThanOrEqual(width >= 1440 ? 300 : 200);
        }
        // Credits opens a full-width panel below all three.
        await page.locator("#wordlist-credits summary").click();
        const panel = await page.locator("#wordlist-credits ul").boundingBox();
        const after = await footerGeometry(page);
        if (!panel) throw new Error("Missing Credits panel");
        expect(panel.y).toBeGreaterThanOrEqual(after.code.bottom);
        expect(Math.abs(panel.x - after.footer.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(panel.x + panel.width - after.footer.right)).toBeLessThanOrEqual(1);
        expect(Math.abs(after.privacy.centre - after.code.centre)).toBeLessThanOrEqual(2);
      });
    }
  }

  for (const width of [1024, 1199, 901]) {
    for (const style of STYLES) {
      test(`two columns, privacy and meta left, settings code right: ${style}/${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openPage(page);
        await chooseStyle(page, style);
        const g = await footerGeometry(page);
        expect(g.overflow).toBeLessThanOrEqual(0);
        expect(Math.abs(g.privacy.left - g.content.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(g.meta.left - g.content.left)).toBeLessThanOrEqual(1);
        expect(g.meta.top).toBeGreaterThanOrEqual(g.privacy.bottom - 1);
        expect(new Set(g.metaItems.map((item) => Math.round(item.top))).size, "meta on one row").toBe(1);
        expect(g.code.left).toBeGreaterThan(Math.max(g.privacy.right, g.meta.right));
        expect(Math.abs(g.code.right - g.content.right)).toBeLessThanOrEqual(1);
        expect(Math.abs(g.code.top - g.privacy.top)).toBeLessThanOrEqual(1);
      });
    }
  }

  for (const width of [900, 768, 412, 360, 320]) {
    for (const style of STYLES) {
      test(`stacked in reading order, privacy, meta, settings code: ${style}/${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openPage(page);
        await chooseStyle(page, style);
        const g = await footerGeometry(page);
        expect(g.overflow).toBeLessThanOrEqual(0);
        expect(g.meta.top).toBeGreaterThanOrEqual(g.privacy.bottom - 1);
        expect(g.code.top).toBeGreaterThanOrEqual(g.meta.bottom);
        for (const box of [g.privacy, g.meta, g.code])
          expect(Math.abs(box.left - g.content.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(g.code.right - g.content.right)).toBeLessThanOrEqual(1);
        expect(new Set(g.metaItems.map((item) => Math.round(item.top))).size, "meta on one row").toBe(1);
        expect(g.meta.right).toBeLessThanOrEqual(g.content.right + 1);
      });
    }
  }

  for (const width of [1440, 1024, 412]) {
    test(`keyboard order follows the reading order: ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPage(page);
      await page.locator("#license-link").focus();
      const order = ["#wordlist-credits summary", "#repo-link", "#copy-settings-code", "#settings-code-input"];
      for (const selector of order) {
        await page.keyboard.press("Tab");
        await expect(page.locator(selector), selector).toBeFocused();
      }
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Apply settings code" })).toBeFocused();
    });
  }
});

test.describe("settings code box", () => {
  test("always open, with its title, subtitle and hint, the live code with Copy, and the Apply field; no Get button", async ({
    page,
  }) => {
    await openPage(page);
    const box = page.locator("footer .settings-code");
    await expect(box).toBeVisible();
    await expect(box.locator("details, summary")).toHaveCount(0);
    await expect(box.getByRole("heading", { name: "Settings code" })).toBeVisible();
    await expect(box).toContainText("Use these settings in another browser");
    await expect(page.locator("#settings-code-hint")).toContainText("follows your settings");
    await expect(page.locator("#settings-code-value")).toHaveText("PG1-ZW");
    await expect(page.locator("#settings-code-value")).toHaveAccessibleName("Settings code for the current settings");
    await expect(page.getByRole("button", { name: "Copy settings code" })).toBeEnabled();
    await expect(page.getByLabel("Code to apply")).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply settings code" })).toHaveText("Apply");
    await expect(page.locator("#get-settings-code")).toHaveCount(0);
    await expect(page.getByText("Get settings code")).toHaveCount(0);
    // A bordered box of its own.
    const border = await box.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.borderTopStyle, Number.parseFloat(s.borderTopWidth)] as const;
    });
    expect(border[0]).toBe("solid");
    expect(border[1]).toBeGreaterThanOrEqual(1);
  });
});

// The settings code box is a panel like the generator cards, so it takes the
// card corner radius in every style and theme, never the small-control radius
// (a pill in Purple). The buttons and field inside keep the control radius.
test.describe("settings code box corners", () => {
  for (const style of STYLES) {
    test(`match the generator cards: ${style}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openPage(page);
      await chooseStyle(page, style);
      for (const theme of ["light", "dark"] as const) {
        await chooseTheme(page, theme);
        const r = await page.evaluate(() => {
          const radius = (selector: string) => {
            const el = document.querySelector(selector);
            if (!el) throw new Error(`Missing ${selector}`);
            const s = getComputedStyle(el);
            return Math.max(...[s.borderTopLeftRadius, s.borderBottomRightRadius].map((v) => Number.parseFloat(v)));
          };
          const control = document.documentElement;
          const token = (name: string) => getComputedStyle(control).getPropertyValue(name).trim();
          return {
            box: radius(".settings-code"),
            card: radius(".gen"),
            cardToken: token("--radius"),
            controlToken: token("--radius-sm"),
            copy: getComputedStyle(document.getElementById("copy-settings-code") as Element).borderTopLeftRadius,
            input: getComputedStyle(document.getElementById("settings-code-input") as Element).borderTopLeftRadius,
          };
        });
        expect(Math.abs(r.box - r.card), `${style}/${theme} box ${r.box}px vs card ${r.card}px`).toBeLessThanOrEqual(1);
        expect(Math.abs(r.box - Number.parseFloat(r.cardToken))).toBeLessThanOrEqual(1);
        // The controls inside keep the small-control radius (Purple's pills).
        for (const v of [r.copy, r.input]) expect(v).toBe(r.controlToken);
      }
    });
  }
});
