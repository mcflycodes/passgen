// Showing a settings code moves nothing: the code slot keeps the height of
// the longest code this deployment can produce, so the Apply row below it
// stays put whether the shown code is the shortest or the longest, at phone
// and desktop widths, in every style. The shown code stays whole: nothing is
// clipped or scrolled out of view.

import type { Page } from "@playwright/test";
import type { StoredSettings } from "../../src/boot/stored-settings.ts";
import { BASELINE, encodeSettingsCode } from "../../src/core/settings-code.ts";
import { CODE_APPLIED_STATUS, CODE_READY_STATUS } from "../../src/ui/settings-code.ts";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, expectStablePosition, openPage, STYLES } from "./helpers.ts";

/**
 * The longest code a page will show for `style`: every field away from its
 * baseline that valid settings allow (two of the seven password switches
 * must stay, so some type is selected and the R11b adjustment leaves the
 * Max counts as they are).
 */
function longestValid(style: string): string {
  const settings: StoredSettings = {
    theme: "dark",
    style,
    password: {
      length: 30,
      lowercase: false,
      uppercase: false,
      numbers: true,
      simple: true,
      complex: false,
      excludeLookAlikes: true,
      dontStartWithSymbol: false,
      counts: {
        lowercase: { min: 0, max: 5 },
        uppercase: { min: 0, max: 5 },
        numbers: { min: 2, max: 15 },
        symbols: { min: 2, max: 15 },
      },
    },
    passphrase: {
      ...BASELINE.passphrase,
      wordList: "orchard-medium",
      words: 6,
      minWordLength: 4,
      maxWordLength: 9,
      number: false,
      excludeLookAlikes: true,
      separatorSymbol: "-",
      numberDigits: 3,
      symbolPosition: "after",
      capitalize: "every",
    },
  };
  return encodeSettingsCode(settings);
}

/**
 * The top of the Apply row's controls, measured from the top of the row
 * holding Get and the code slot, so a change elsewhere on the page (a code that changes the
 * generators) does not count; only the slot lies between them.
 */
function applyRow(page: Page) {
  return page.evaluate(() => {
    const top = (id: string) => {
      const element = document.getElementById(id);
      if (!element) throw new Error(`Missing ${id}`);
      return element.getBoundingClientRect().top;
    };
    const row = document.getElementById("get-settings-code")?.closest(".code-row");
    if (!row) throw new Error("Missing the Get row");
    const get = row.getBoundingClientRect().top;
    return [top("settings-code-input") - get, top("apply-settings-code") - get];
  });
}

/** Whether the shown code is whole: no overflow clipped, scrolled or hidden. */
function whole(page: Page) {
  return page.locator("#settings-code-value").evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      fits: el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1,
      overflow: [style.overflowX, style.overflowY],
      selectable: style.userSelect !== "none",
    };
  });
}

test("the longest valid code is at least as long as the longest the review measured", () => {
  for (const style of STYLES) expect(longestValid(style).length).toBeGreaterThanOrEqual(style === "calm" ? 60 : 63);
});

for (const width of [320, 393, 1440]) {
  for (const style of STYLES) {
    test(`showing the shortest and longest code moves nothing: ${style}/${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPage(page);
      await chooseStyle(page, style);
      const get = page.locator("#get-settings-code");
      const shown = page.locator("#settings-code-value");
      const status = page.locator("#settings-code-status");

      // Shortest: the code for these settings, which differ from the defaults by the style at most.
      const before = await applyRow(page);
      await get.click();
      await expect(status).toHaveText(CODE_READY_STATUS);
      await expect(shown).not.toHaveText("");
      expectStablePosition(await applyRow(page), before, `${style}/${width} shortest code`);
      expect(await whole(page)).toEqual({ fits: true, overflow: ["visible", "visible"], selectable: true });

      // Longest: apply it, then show it.
      const code = longestValid(style);
      await page.locator("#settings-code-input").fill(code);
      await page.locator("#apply-settings-code").click();
      await expect(status).toHaveText(CODE_APPLIED_STATUS);
      const applied = await applyRow(page);
      await get.click();
      await expect(shown).toHaveText(code);
      expectStablePosition(await applyRow(page), applied, `${style}/${width} longest code`);
      expect(await whole(page)).toEqual({ fits: true, overflow: ["visible", "visible"], selectable: true });
      // The empty slot and a shown code take the same room either way.
      expectStablePosition(applied, before, `${style}/${width} empty slot`);
    });
  }
}
