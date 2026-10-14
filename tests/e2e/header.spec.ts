// v1.5.1 header. From 900px one row: the name, then the Style control, the
// theme switch, a thin decorative separator, Save and Reset; no GitHub link
// (it is in the footer). Below 900px a compact 53px row: the name, the
// Appearance button, the separator, Save and Reset; the Style and theme
// controls open from the Appearance button as a panel that Escape, a click
// outside or moving focus away closes. The header is pinned at every width
// down to 320px with no horizontal scroll, and focused controls scroll clear
// of it; only a viewport under 400px tall leaves it in normal flow.

import type { Page } from "@playwright/test";
import { contrastRatio } from "../../scripts/lib/style-checks.ts";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, chooseTheme, openPage, STYLES } from "./helpers.ts";

type Item = { name: string; left: number; right: number; top: number; bottom: number };

/** The visible header items, left to right, named by what they are. */
function headerItems(page: Page) {
  return page.evaluate(() => {
    const named: Array<[string, string]> = [
      [".brand", "brand"],
      ["#appearance-toggle", "appearance"],
      [".style-control", "style"],
      ["#theme-control", "theme"],
      [".top-sep", "separator"],
      ["#header-save-settings", "save"],
      ["#header-reset-settings", "reset"],
    ];
    const items: Item[] = [];
    for (const [selector, name] of named) {
      const el = document.querySelector(`.top ${selector}`);
      if (!el?.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      items.push({ name, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    return items.sort((a, b) => a.left - b.left);
  });
}

function headerState(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector(".top");
    if (!header) throw new Error("Missing header");
    const r = header.getBoundingClientRect();
    return {
      position: getComputedStyle(header).position,
      top: r.top,
      bottom: r.bottom,
      height: r.height,
      styleHeight: Number.parseFloat(getComputedStyle(header).getPropertyValue("--header-h")),
      overflow: document.documentElement.scrollWidth - innerWidth,
      scrollPadding: Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop),
    };
  });
}

/** An opaque rgb() triple, for contrast. */
function rgb(value: string) {
  const m = value.match(/^rgba?\((\d+), (\d+), (\d+)/);
  if (!m) throw new Error(`Unexpected colour ${value}`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: 1 };
}

test.describe("header order", () => {
  for (const width of [1920, 1440, 1024, 900]) {
    test(`style, theme, separator, Save, Reset after the name, and no GitHub: ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPage(page);
      const items = await headerItems(page);
      expect(items.map((item) => item.name)).toEqual(["brand", "style", "theme", "separator", "save", "reset"]);
      // One row, and no item overlaps the next.
      for (const [i, item] of items.entries()) {
        const next = items[i + 1];
        if (next) expect(item.right, `${item.name} before ${next.name}`).toBeLessThanOrEqual(next.left);
        const header = await headerState(page);
        expect(item.top).toBeGreaterThanOrEqual(header.top);
        expect(item.bottom).toBeLessThanOrEqual(header.bottom);
      }
      await expect(page.locator("#appearance-toggle")).toBeHidden();
    });
  }

  for (const width of [899, 768, 412, 360, 320]) {
    test(`name, Appearance, separator, Save, Reset in one compact row: ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openPage(page);
      const items = await headerItems(page);
      expect(items.map((item) => item.name)).toEqual(["brand", "appearance", "separator", "save", "reset"]);
      const header = await headerState(page);
      for (const item of items) {
        expect(item.top, item.name).toBeGreaterThanOrEqual(header.top);
        expect(item.bottom, item.name).toBeLessThanOrEqual(header.bottom);
        expect(item.right, item.name).toBeLessThanOrEqual(width);
      }
      for (const [i, item] of items.entries()) {
        const next = items[i + 1];
        if (next) expect(item.right, `${item.name} before ${next.name}`).toBeLessThanOrEqual(next.left);
      }
      // Short labels on screen, full names for assistive technology.
      await expect(page.locator("#header-save-settings .hb-short")).toBeVisible();
      await expect(page.locator("#header-save-settings")).toHaveAccessibleName("Save as my default");
      await expect(page.locator("#header-reset-settings .hb-short")).toBeVisible();
      await expect(page.locator("#header-reset-settings")).toHaveAccessibleName("Reset to defaults");
      await expect(page.locator("#appearance-toggle")).toHaveAccessibleName("Appearance");
      await expect(page.locator("#style")).toBeHidden();
      await expect(page.locator("#theme-control")).toBeHidden();
      for (const id of ["appearance-toggle", "header-save-settings", "header-reset-settings"]) {
        const box = await page.locator(`#${id}`).boundingBox();
        expect(box?.width, id).toBeGreaterThanOrEqual(24);
        expect(box?.height, id).toBeGreaterThanOrEqual(24);
      }
    });
  }

  test("the header has no GitHub link at any width, and the footer has it", async ({ page }) => {
    for (const width of [1440, 1024, 412, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await openPage(page);
      await expect(page.locator(".top a")).toHaveCount(0);
      await expect(page.locator(".top svg path[d^='M 6.766']")).toHaveCount(0);
      await expect(page.locator(".top").getByText("GitHub")).toHaveCount(0);
      await expect(page.locator(".top [aria-label='GitHub'], .top [title='GitHub']")).toHaveCount(0);
      if ((await page.locator("#appearance-toggle").isVisible()) === true) {
        await page.locator("#appearance-toggle").click();
        await expect(page.locator("#appearance-panel a")).toHaveCount(0);
        await expect(page.locator("#appearance-panel")).not.toContainText("GitHub");
      }
      await expect(page.locator("footer #repo-link")).toHaveCount(1);
    }
  });
});

test.describe("header separator", () => {
  for (const style of STYLES) {
    for (const theme of ["light", "dark"] as const) {
      test(`decorative, drawn in the style's line colour and visible: ${style}/${theme}`, async ({ page }) => {
        await openPage(page);
        await chooseStyle(page, style);
        await chooseTheme(page, theme);
        for (const width of [1440, 412]) {
          await page.setViewportSize({ width, height: 800 });
          const sep = page.locator(".top .top-sep");
          await expect(sep).toHaveCount(1);
          await expect(sep).toHaveAttribute("aria-hidden", "true");
          await expect(sep).toBeVisible();
          const drawn = await sep.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const header = document.querySelector(".top") as HTMLElement;
            const h = header.getBoundingClientRect();
            // The token's colour, resolved by the browser in this style and theme.
            const probe = document.createElement("span");
            probe.style.setProperty("color", "var(--line-strong)");
            document.body.append(probe);
            const token = getComputedStyle(probe).color;
            probe.remove();
            // The header's surface: its translucent background over the page background.
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d") as CanvasRenderingContext2D;
            context.fillStyle = getComputedStyle(document.documentElement).backgroundColor;
            context.fillRect(0, 0, 1, 1);
            context.fillStyle = getComputedStyle(header).backgroundColor;
            context.fillRect(0, 0, 1, 1);
            context.fillStyle = getComputedStyle(el).backgroundColor;
            const [r0, g0, b0] = context.getImageData(0, 0, 1, 1).data;
            context.fillRect(0, 0, 1, 1);
            const [r1, g1, b1] = context.getImageData(0, 0, 1, 1).data;
            return {
              width: r.width,
              height: r.height,
              centre: r.top + r.height / 2 - (h.top + h.height / 2),
              background: getComputedStyle(el).backgroundColor,
              token,
              surface: `rgb(${r0}, ${g0}, ${b0})`,
              line: `rgb(${r1}, ${g1}, ${b1})`,
            };
          });
          expect(drawn.width).toBeGreaterThanOrEqual(1);
          expect(drawn.width).toBeLessThanOrEqual(2);
          expect(drawn.height).toBeGreaterThanOrEqual(16);
          expect(Math.abs(drawn.centre), "vertically centred").toBeLessThanOrEqual(1);
          expect(drawn.background, "uses --line-strong").toBe(drawn.token);
          // A thin rule needs no text contrast, but it must not vanish into the header.
          expect(contrastRatio(rgb(drawn.line), rgb(drawn.surface)), `${style}/${theme}/${width}`).toBeGreaterThan(1.3);
        }
      });
    }
  }
});

test.describe("pinned header", () => {
  for (const width of [1440, 1024, 412, 360, 320]) {
    test(`stays at the top while the page scrolls, with no horizontal scroll: ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openPage(page);
      const first = await headerState(page);
      expect(first.position).toBe("sticky");
      expect(first.overflow, "horizontal overflow").toBeLessThanOrEqual(0);
      if (width >= 900) expect(first.height).toBe(first.styleHeight);
      else expect(Math.abs(first.height - 53), "compact row about 53px").toBeLessThanOrEqual(1);
      expect(first.scrollPadding, "focused controls scroll clear of it").toBeGreaterThanOrEqual(first.height + 16);
      for (const y of [600, 100_000]) {
        await page.evaluate((to) => window.scrollTo(0, to), y);
        const scrolled = await headerState(page);
        expect(scrolled.top, `pinned at ${y}`).toBe(0);
        expect(scrolled.height).toBe(first.height);
        expect(scrolled.overflow).toBeLessThanOrEqual(0);
      }
      await expect(page.locator("#header-save-settings")).toBeInViewport();
    });
  }

  test("keyboard focus is never hidden under the pinned compact header", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await openPage(page);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.locator("#apply-settings-code").focus();
    // Walk backwards from the bottom of the page, as a keyboard user would.
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Shift+Tab");
      const seen = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const header = document.querySelector(".top") as HTMLElement;
        const name = `${el.tagName.toLowerCase()}#${el.id}${el.getAttribute("aria-label") ? ` "${el.getAttribute("aria-label")}"` : ""}`;
        if (header.contains(el)) return { inHeader: true, name, top: 0, bottom: 0, headerBottom: 0 };
        const input = el instanceof HTMLInputElement ? el : null;
        const target =
          input?.type === "checkbox"
            ? (el.nextElementSibling as HTMLElement)
            : input?.type === "radio"
              ? (document.querySelector(`label[for="${el.id}"]`) as HTMLElement)
              : el;
        const r = target.getBoundingClientRect();
        return {
          inHeader: false,
          name,
          top: r.top,
          bottom: r.bottom,
          headerBottom: header.getBoundingClientRect().bottom,
        };
      });
      if (seen.inHeader) break;
      expect(seen.top, `focus stop ${i}: ${seen.name}`).toBeGreaterThanOrEqual(seen.headerBottom - 1);
      expect(seen.bottom, `focus stop ${i}: ${seen.name}`).toBeLessThanOrEqual(640 + 1);
    }
  });

  for (const viewport of [
    { width: 412, height: 380 },
    { width: 320, height: 256 },
    { width: 1280, height: 399 },
  ]) {
    test(`a viewport under 400px tall keeps the header in normal flow: ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openPage(page);
      const state = await headerState(page);
      expect(state.position).toBe("relative");
      expect(state.overflow).toBeLessThanOrEqual(0);
      await page.evaluate(() => window.scrollTo(0, 600));
      expect((await headerState(page)).bottom).toBeLessThanOrEqual(0);
    });
  }
});

test.describe("Appearance panel", () => {
  const toggle = (page: Page) => page.locator("#appearance-toggle");
  const panel = (page: Page) => page.locator("#appearance-panel");

  test("opens and closes with the button, holds the Style and theme controls, and Escape returns focus", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 412, height: 800 });
    await openPage(page);
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(toggle(page)).toHaveAttribute("aria-controls", "appearance-panel");
    await expect(panel(page)).toBeHidden();

    // Keyboard: Enter opens, Tab moves into the panel, Escape closes and returns focus.
    await toggle(page).focus();
    await page.keyboard.press("Enter");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator("#style")).toBeVisible();
    await expect(panel(page).locator("label[for='theme-dark']")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.locator("#style")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(panel(page)).toBeHidden();
    await expect(toggle(page)).toBeFocused();

    // The panel fits the viewport, below the header, and works.
    await toggle(page).click();
    const box = await panel(page).boundingBox();
    const header = await page.locator(".top").boundingBox();
    if (!box || !header) throw new Error("Missing panel or header");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(412);
    expect(box.y).toBeGreaterThanOrEqual(header.y + header.height);
    await page.locator("label[for='theme-dark']").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(panel(page)).toBeVisible();
    await page.locator("#style").selectOption("slate");
    await expect(page.locator("html")).toHaveAttribute("data-style", "slate");
    await expect(panel(page)).toBeVisible();

    // A click outside closes it and puts focus back on the button.
    await page.locator("#style").focus();
    await page.locator(".intro").click({ position: { x: 5, y: 5 } });
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(panel(page)).toBeHidden();
    await expect(toggle(page)).toBeFocused();

    // The button toggles it closed too.
    await toggle(page).click();
    await expect(panel(page)).toBeVisible();
    await toggle(page).click();
    await expect(panel(page)).toBeHidden();
  });

  test("tabbing out of the panel closes it; a click on another control keeps that control's focus", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openPage(page);
    await toggle(page).click();
    await page.locator("#theme-system").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#header-save-settings")).toBeFocused();
    await expect(panel(page)).toBeHidden();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");

    await toggle(page).click();
    await page.locator("#style").focus();
    await page.locator("#pw-length-number").click();
    await expect(panel(page)).toBeHidden();
    await expect(page.locator("#pw-length-number")).toBeFocused();
  });

  test("widening past 900px closes it and puts the controls in the header row", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await openPage(page);
    await toggle(page).click();
    await expect(panel(page)).toBeVisible();
    await page.setViewportSize({ width: 1200, height: 800 });
    await expect(toggle(page)).toBeHidden();
    await expect(page.locator("#style")).toBeVisible();
    const items = await headerItems(page);
    expect(items.map((item) => item.name)).toEqual(["brand", "style", "theme", "separator", "save", "reset"]);
    await page.setViewportSize({ width: 600, height: 800 });
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(panel(page)).toBeHidden();
  });
});
