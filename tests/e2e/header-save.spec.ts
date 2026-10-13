// v1.5.1: "Save as my default" and "Reset to defaults" also sit in the header,
// between the name and the GitHub, Style and theme controls, and work exactly
// like the pair at the bottom. Each press shows its outcome beside the pair
// that was pressed and is announced once. At the bottom, the settings code
// sits beside Save and Reset on wide screens and below them on narrow ones.

import type { Page } from "@playwright/test";
import { SETTINGS_STORAGE_KEY } from "../../src/boot/storage.ts";
import { config } from "../../src/config/validate.ts";
import { RESET_STATUS, SAVE_INVALID_STATUS, SAVED_STATUS } from "../../src/ui/settings.ts";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, openPage, STYLES, setNumber, setRange } from "./helpers.ts";

const headerSave = (page: Page) => page.locator(".top #header-save-settings");
const headerReset = (page: Page) => page.locator(".top #header-reset-settings");
const headerStatus = (page: Page) => page.locator(".top #header-save-status");
const bottomStatus = (page: Page) => page.locator("#save-settings-status");
const storedText = (page: Page) => page.evaluate((key) => localStorage.getItem(key), SETTINGS_STORAGE_KEY);

/** Boxes of the header pieces, for overlap and containment checks. */
function headerGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) throw new Error("Missing header element");
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const header = document.querySelector(".top");
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      viewport: innerWidth,
      header: box(header),
      headerHeight: Number.parseFloat(getComputedStyle(header as Element).getPropertyValue("--header-h")),
      sticky: getComputedStyle(header as Element).position === "sticky",
      save: box(document.getElementById("header-save-settings")),
      reset: box(document.getElementById("header-reset-settings")),
      others: [
        box(document.querySelector(".brand")),
        ...[...document.querySelectorAll(".top-controls > *")]
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => box(el)),
      ],
      clipped: [...document.querySelectorAll<HTMLElement>(".top button, .top label, .top a, .top select")]
        .filter((el) => el.getClientRects().length && getComputedStyle(el).position !== "absolute")
        .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
        .map((el) => el.id || el.className),
    };
  });
}

type Box = { left: number; right: number; top: number; bottom: number };
const overlaps = (a: Box, b: Box) =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

test.describe("header Save and Reset", () => {
  for (const width of [1440, 1024, 768, 390, 320]) {
    for (const style of STYLES) {
      test(`fit in the header without overflow or overlap: ${style}/${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await openPage(page);
        await chooseStyle(page, style);
        await expect(headerSave(page)).toBeVisible();
        await expect(headerReset(page)).toBeVisible();
        await expect(headerSave(page)).toHaveAccessibleName("Save as my default");
        await expect(headerReset(page)).toHaveAccessibleName("Reset to defaults");
        const g = await headerGeometry(page);
        expect(g.overflow, "horizontal overflow").toBeLessThanOrEqual(0);
        expect(g.clipped, "clipped header controls").toEqual([]);
        for (const button of [g.save, g.reset]) {
          expect(button.left).toBeGreaterThanOrEqual(0);
          expect(button.right).toBeLessThanOrEqual(g.viewport);
          expect(button.top).toBeGreaterThanOrEqual(g.header.top);
          expect(button.bottom).toBeLessThanOrEqual(g.header.bottom);
          expect(button.width).toBeGreaterThanOrEqual(24);
          expect(button.height).toBeGreaterThanOrEqual(24);
          for (const other of g.others) expect(overlaps(button, other), JSON.stringify({ button, other })).toBe(false);
        }
        expect(overlaps(g.save, g.reset)).toBe(false);
        // Name first, then Save and Reset, then the GitHub, Style and theme controls.
        const [brand, ...controls] = g.others;
        if (!brand) throw new Error("Missing brand");
        for (const button of [g.save, g.reset]) {
          const sameRow = (other: Box) => other.top < button.bottom && button.top < other.bottom;
          if (sameRow(brand)) expect(button.left).toBeGreaterThanOrEqual(brand.right);
          for (const control of controls) if (sameRow(control)) expect(button.right).toBeLessThanOrEqual(control.left);
        }
        // The pinned single-row header keeps its configured height.
        if (g.sticky) expect(g.header.height).toBe(g.headerHeight);

        // It works: the header Save writes the record and confirms it in the header.
        await headerSave(page).click();
        await expect(headerSave(page)).toHaveClass(/is-done/);
        await expect(headerStatus(page)).toHaveText(SAVED_STATUS);
        expect(await storedText(page)).not.toBeNull();
        const after = await headerGeometry(page);
        expect(after.overflow, "overflow while confirming").toBeLessThanOrEqual(0);
        expect(after.clipped, "clipped while confirming").toEqual([]);
        expect(Math.abs(after.save.width - g.save.width), "Save keeps its width").toBeLessThanOrEqual(0.5);
        expect(Math.abs(after.header.height - g.header.height), "header keeps its height").toBeLessThanOrEqual(0.5);
        await headerReset(page).click();
        await expect(headerStatus(page)).toHaveText(RESET_STATUS);
        expect(await storedText(page)).toBeNull();
      });
    }
  }

  test("header Save saves (a reload restores it) and confirms visibly in the header, announced once", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openPage(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(headerStatus(page)).toHaveAttribute("role", "status");
    await expect(headerStatus(page)).toHaveAttribute("aria-live", "polite");
    await chooseStyle(page, "purple");
    await setRange(page.locator("#pw-length"), 31);
    await headerSave(page).click();
    // Visible in the header: the pressed button is highlighted and says Saved.
    await expect(headerSave(page)).toHaveClass(/is-done/);
    await expect(headerSave(page).locator(".hb-ok")).toBeVisible();
    await expect(headerSave(page).locator(".hb-ok")).toHaveText("Saved");
    await expect(headerSave(page).locator(".hb-idle")).toBeHidden();
    await expect(headerSave(page)).toHaveAccessibleName("Save as my default");
    // Announced once: only the status beside the pressed pair speaks.
    await expect(headerStatus(page)).toHaveText(SAVED_STATUS);
    await expect(bottomStatus(page)).toBeEmpty();
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    // The highlight ends after the feedback time.
    await expect(headerSave(page)).not.toHaveClass(/is-done/, { timeout: 5000 });
    await expect(headerSave(page).locator(".hb-idle")).toBeVisible();
    await expect(headerStatus(page)).toBeEmpty();

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    await expect(page.locator("html")).toHaveAttribute("data-style", "purple");
    await expect(page.locator("#pw-length-number")).toHaveValue("31");

    // The bottom pair still speaks for itself, and the header stays quiet.
    await page.locator("#save-settings").click();
    await expect(bottomStatus(page)).toHaveText(SAVED_STATUS);
    await expect(headerStatus(page)).toBeEmpty();
    await expect(headerSave(page)).not.toHaveClass(/is-done/);
    // A header press takes over: the bottom status clears, so nothing is said twice.
    await headerSave(page).click();
    await expect(headerStatus(page)).toHaveText(SAVED_STATUS);
    await expect(bottomStatus(page)).toBeEmpty();
    await expect(page.locator("#save-settings")).not.toHaveClass(/is-done/);
  });

  test("header Reset clears the record, restores the defaults and confirms in the header", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPage(page);
    await setRange(page.locator("#pw-length"), 33);
    await headerSave(page).click();
    await expect(headerStatus(page)).toHaveText(SAVED_STATUS);
    expect(await storedText(page)).not.toBeNull();
    await headerReset(page).click();
    await expect(headerReset(page)).toHaveClass(/is-done/);
    await expect(headerReset(page).locator(".hb-ok")).toHaveText("Cleared");
    await expect(headerReset(page).locator(".hb-ok")).toBeVisible();
    await expect(headerStatus(page)).toHaveText(RESET_STATUS);
    await expect(bottomStatus(page)).toBeEmpty();
    expect(await storedText(page)).toBeNull();
    await expect(page.locator("#pw-length-number")).toHaveValue(String(config.password.length.default));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    await expect(page.locator("#pw-length-number")).toHaveValue(String(config.password.length.default));
  });

  test("a refused header Save says so in the header and writes nothing", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await openPage(page);
    await setNumber(page.locator("#pw-lowercase-min"), 99);
    await headerSave(page).click();
    await expect(headerSave(page)).toHaveClass(/is-error/);
    await expect(headerSave(page).locator(".hb-fail")).toBeVisible();
    await expect(headerSave(page).locator(".hb-fail")).toHaveText("Failed");
    await expect(headerStatus(page)).toHaveText(SAVE_INVALID_STATUS);
    await expect(bottomStatus(page)).toBeEmpty();
    expect(await storedText(page)).toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  });

  test("ids stay unique with both pairs on the page", async ({ page }) => {
    await openPage(page);
    const duplicates = await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
      return ids.filter((id, i) => ids.indexOf(id) !== i);
    });
    expect(duplicates).toEqual([]);
    await expect(page.getByRole("button", { name: "Save as my default" })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Reset to defaults" })).toHaveCount(2);
  });
});

/** The save block, the settings code block and the content edges they align to. */
function bottomGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`Missing ${selector}`);
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      content: box(".generators"),
      save: box(".save-block"),
      saveButton: box("#save-settings"),
      code: box(".settings-code"),
      codeValue: box("#settings-code-value"),
      codeInput: box("#settings-code-input"),
      footText: box(".foot-text"),
      codeRows: [...document.querySelectorAll(".settings-code .code-row")].map((row) => {
        const r = row.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
    };
  });
}

test.describe("Save and the settings code at the bottom", () => {
  for (const width of [1440, 1280, 1024, 901]) {
    for (const style of STYLES) {
      test(`side by side, settings code right-aligned: ${style}/${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openPage(page);
        await chooseStyle(page, style);
        const g = await bottomGeometry(page);
        expect(g.overflow).toBeLessThanOrEqual(0);
        // One row: Save on the left at the content's left edge, the code block on the right.
        expect(Math.abs(g.save.left - g.content.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(g.code.right - g.content.right)).toBeLessThanOrEqual(1);
        expect(Math.abs(g.code.top - g.save.top)).toBeLessThanOrEqual(1);
        expect(g.code.left).toBeGreaterThan(g.save.right);
        for (const row of g.codeRows) expect(Math.abs(row.right - g.content.right)).toBeLessThanOrEqual(1);
      });
    }
  }
  // v1.5.1: the row sits close to the footer, and the settings code has room.
  // The footer's own 24px top padding is the only space before its text, so
  // 32px allows for rounding; the shorter Save column leaves less than a
  // control row and a half (64px) empty below its hint. At 720px the code
  // block's hint takes at most two lines and each field keeps 400px, room for
  // the longest code on one line (main had a 576px block with a 297px field).
  for (const width of [1440, 1920]) {
    for (const style of STYLES) {
      test(`close to the footer, settings code with room: ${style}/${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openPage(page);
        await chooseStyle(page, style);
        const g = await bottomGeometry(page);
        const rowBottom = Math.max(g.save.bottom, g.code.bottom);
        expect(g.footText.top - rowBottom).toBeLessThanOrEqual(32);
        expect(rowBottom - g.save.bottom).toBeLessThanOrEqual(64);
        expect(g.code.right - g.code.left).toBeGreaterThanOrEqual(720);
        expect(g.codeInput.right - g.codeInput.left).toBeGreaterThanOrEqual(400);
        expect(g.codeValue.right - g.codeValue.left).toBeGreaterThanOrEqual(400);
      });
    }
  }
  for (const width of [901, 900, 390]) {
    test(`close to the footer: ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPage(page);
      const g = await bottomGeometry(page);
      expect(g.footText.top - Math.max(g.save.bottom, g.code.bottom)).toBeLessThanOrEqual(32);
    });
  }
  for (const width of [900, 768, 390, 320]) {
    for (const style of STYLES) {
      test(`stacked, Save first: ${style}/${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openPage(page);
        await chooseStyle(page, style);
        const g = await bottomGeometry(page);
        expect(g.overflow).toBeLessThanOrEqual(0);
        expect(g.code.top).toBeGreaterThanOrEqual(g.save.bottom);
        expect(Math.abs(g.save.left - g.content.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(g.code.left - g.content.left)).toBeLessThanOrEqual(1);
        expect(g.code.right).toBeLessThanOrEqual(g.content.right + 1);
      });
    }
  }
});
