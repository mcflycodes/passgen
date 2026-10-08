// Shared helpers for the interface tests.

import type { Locator, Page } from "@playwright/test";
import { config } from "../../src/config/validate.ts";
import { expect } from "./fixtures.ts";

export const STYLES = config.style.offered.map((s) => s.id);
export const THEMES = ["system", "light", "dark"] as const;

export async function openPage(page: Page, url = "./"): Promise<void> {
  await page.goto(url);
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
}

/** The generated text of a result box. */
export const resultText = (page: Page, id: "pw-value" | "pp-value") => page.locator(`#${id}`).innerText();

/** Sets a range input the way a user would, firing the input event. */
export async function setRange(locator: Locator, value: number): Promise<void> {
  await locator.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

/** Sets a number field as typed input and commits it (input, then change). */
export async function setNumber(locator: Locator, value: number | string): Promise<void> {
  await locator.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/** Waits for colour transitions to finish, so a check reads final colours. */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState === "finished"));
}

/** Chooses a style through the Style control. */
export async function chooseStyle(page: Page, style: string): Promise<void> {
  await page.locator("#style").selectOption(style);
  await expect(page.locator("html")).toHaveAttribute("data-style", style);
  await settle(page);
}

export async function chooseTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  // The radio itself is visually hidden; its label is the control a user sees.
  await page.locator(`label[for="theme-${theme}"]`).click();
  await expect(page.locator(`#theme-${theme}`)).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await settle(page);
}

/** The computed page background as an rgb triple. */
export async function pageBackground(page: Page): Promise<[number, number, number]> {
  const color = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) throw new Error(`unexpected colour ${color}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export const isDark = ([r, g, b]: [number, number, number]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
