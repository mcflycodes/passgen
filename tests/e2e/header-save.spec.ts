// v1.5.2: "Save as my default" and "Reset to defaults" are in the header
// only, at the right end after the Style and theme controls (or, below
// 900px, the Appearance button) and a separator. Each press shows its outcome
// on the pressed button and is announced once. The header order, the
// separator, pinning and the Appearance panel are in header.spec.ts.

import type { Page } from "@playwright/test";
import { SETTINGS_STORAGE_KEY } from "../../src/boot/storage.ts";
import { config } from "../../src/config/validate.ts";
import { RESET_STATUS, SAVE_INVALID_STATUS, SAVED_STATUS } from "../../src/ui/settings.ts";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, openPage, STYLES, setNumber, setRange } from "./helpers.ts";

const headerSave = (page: Page) => page.locator(".top #header-save-settings");
const headerReset = (page: Page) => page.locator(".top #header-reset-settings");
const headerStatus = (page: Page) => page.locator(".top #header-save-status");
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
        ...[...document.querySelectorAll(".top-controls > *, #appearance-toggle, .top-sep")]
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
        // One row: Save and Reset come after everything else in the header, Reset last.
        for (const button of [g.save, g.reset]) {
          for (const other of g.others) {
            expect(other.top < button.bottom && button.top < other.bottom, "same row").toBe(true);
            expect(button.left).toBeGreaterThanOrEqual(other.right);
          }
        }
        expect(g.reset.left).toBeGreaterThanOrEqual(g.save.right);
        // The pinned single-row header keeps its height: the style's from 900px, a compact row below.
        expect(g.sticky).toBe(true);
        expect(g.header.height).toBe(width >= 900 ? g.headerHeight : 53);

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
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    // The highlight ends after the feedback time.
    await expect(headerSave(page)).not.toHaveClass(/is-done/, { timeout: 5000 });
    await expect(headerSave(page).locator(".hb-idle")).toBeVisible();
    await expect(headerStatus(page)).toBeEmpty();

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    await expect(page.locator("html")).toHaveAttribute("data-style", "purple");
    await expect(page.locator("#pw-length-number")).toHaveValue("31");

    // Pressing again announces again: the status is replaced, not appended.
    await headerSave(page).click();
    await expect(headerStatus(page)).toHaveText(SAVED_STATUS);
    await expect(page.getByRole("status").filter({ hasText: SAVED_STATUS })).toHaveCount(1);
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
    expect(await storedText(page)).toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  });

  test("Save and Reset are only in the header: the bottom pair is gone from the page", async ({ page }) => {
    await openPage(page);
    const duplicates = await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
      return ids.filter((id, i) => ids.indexOf(id) !== i);
    });
    expect(duplicates).toEqual([]);
    await expect(page.getByRole("button", { name: "Save as my default" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Reset to defaults" })).toHaveCount(1);
    await expect(page.locator(".top").getByRole("button", { name: "Save as my default" })).toHaveCount(1);
    await expect(page.locator(".top").getByRole("button", { name: "Reset to defaults" })).toHaveCount(1);
    for (const gone of ["#save-settings", "#reset-settings", "#save-settings-status", ".save-settings", ".save-block"])
      await expect(page.locator(gone), gone).toHaveCount(0);
    // The hint stays: it describes both buttons and is their tooltip.
    await expect(headerSave(page)).toHaveAccessibleDescription(/Nothing generated is ever stored/);
    await expect(headerReset(page)).toHaveAccessibleDescription(/Nothing generated is ever stored/);
  });
});
