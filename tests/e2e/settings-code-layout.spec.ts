// The live settings code moves nothing: the code slot keeps the height of
// the longest code this deployment can produce (and of the message shown
// while the settings cannot make one), so the Apply row below it and the box
// around it stay put whether the shown code is the shortest or the longest,
// or the message, at phone and desktop widths, in every style. The shown code
// stays whole: nothing is clipped or scrolled out of view.

import type { Page } from "@playwright/test";
import type { StoredSettings } from "../../src/boot/stored-settings.ts";
import { BASELINE, encodeSettingsCode } from "../../src/core/settings-code.ts";
import { CODE_APPLIED_STATUS, CODE_UNAVAILABLE_TEXT } from "../../src/ui/settings-code.ts";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, expectStablePosition, openPage, STYLES, setNumber } from "./helpers.ts";

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
 * The top of the Apply row's controls and the height of the settings code
 * box, measured from the top of the row holding the code slot and Copy, so a
 * change elsewhere on the page (a code that changes the generators) does not
 * count; only the slot lies between them.
 */
function applyRow(page: Page) {
  return page.evaluate(() => {
    const element = (id: string) => {
      const found = document.getElementById(id);
      if (!found) throw new Error(`Missing ${id}`);
      return found;
    };
    const row = element("settings-code-value").closest(".code-row");
    if (!row) throw new Error("Missing the code row");
    const top = row.getBoundingClientRect().top;
    return [
      element("settings-code-input").getBoundingClientRect().top - top,
      element("apply-settings-code").getBoundingClientRect().top - top,
      element("settings-code").getBoundingClientRect().height,
    ];
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

for (const width of [320, 393, 1024, 1440]) {
  for (const style of STYLES) {
    test(`the live code moves nothing as it changes length: ${style}/${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPage(page);
      await chooseStyle(page, style);
      const shown = page.locator("#settings-code-value");
      const status = page.locator("#settings-code-status");

      // Shortest: the code for these settings, which differ from the defaults by the style at most.
      await expect(shown).toHaveText(/^PG1-/);
      const before = await applyRow(page);
      expect(await whole(page)).toEqual({ fits: true, overflow: ["visible", "visible"], selectable: true });

      // The unavailable message takes the same room as any code.
      await setNumber(page.locator("#pw-lowercase-min"), 99);
      await expect(shown).toHaveText(CODE_UNAVAILABLE_TEXT);
      await expect(status).toHaveText("");
      expectStablePosition(await applyRow(page), before, `${style}/${width} unavailable`);
      expect(await whole(page)).toEqual({ fits: true, overflow: ["visible", "visible"], selectable: true });
      await setNumber(page.locator("#pw-lowercase-min"), 0);
      await expect(shown).toHaveText(/^PG1-/);
      expectStablePosition(await applyRow(page), before, `${style}/${width} back to a code`);

      // Longest: apply it; the slot shows it at once.
      const code = longestValid(style);
      await page.locator("#settings-code-input").fill(code);
      await page.locator("#apply-settings-code").click();
      await expect(status).toHaveText(CODE_APPLIED_STATUS);
      await expect(shown).toHaveText(code);
      const applied = await applyRow(page);
      expect(await whole(page)).toEqual({ fits: true, overflow: ["visible", "visible"], selectable: true });
      // The status line below the Apply row is the only thing the press added.
      expectStablePosition(applied.slice(0, 2), before.slice(0, 2), `${style}/${width} longest code`);
      // A later change clears the status; the box is back to its first height with a shorter code.
      await page.locator("#pp-lookalikes").uncheck();
      await expect(status).toHaveText("");
      await expect(shown).not.toHaveText(code);
      expectStablePosition(await applyRow(page), before, `${style}/${width} after the longest code`);
    });
  }
}
