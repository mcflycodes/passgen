import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, chooseTheme, openPage, STYLES, setChecked, setNumber, setOpen, setRange } from "./helpers.ts";

const capture = process.env.V141_CAPTURE;
const shots = process.env.V141_SCREENSHOT_DIR;

// Exercise both cards in every style/theme, including warnings on phones.
// On stacked cards, longer extras can move the following card as a whole;
// settings must keep their position inside their own card.
async function stationaryControls(page: Page) {
  const positions = () =>
    page.locator(".controls .control-row").evaluateAll((rows) =>
      rows.map((row) => {
        const card = row.closest(".gen");
        if (!card) throw new Error("Missing generator card");
        return row.getBoundingClientRect().top - card.getBoundingClientRect().top;
      }),
    );
  const initial = await positions();
  const check = async () => {
    const current = await positions();
    for (const [i, top] of current.entries())
      expect(Math.abs(top - (initial[i] ?? 0)), `settings row ${i} movement`).toBeLessThanOrEqual(0.5);
  };
  for (const length of [4, 20, 40]) {
    await setRange(page.locator("#pw-length"), length);
    await check();
  }
  await expect(page.locator("#pw-band")).toHaveText("Excellent");
  await setOpen(page.locator("#pw-meter details"), true);
  await expect(page.locator("#pw-scenarios")).toContainText("NTLM search capped");
  await setOpen(page.locator("#pw-meter details"), false);
  await check();
  for (const field of ["min", "max"] as const) {
    await setNumber(page.locator(`#pw-lowercase-${field}`), field === "min" ? 2 : 39);
    await check();
  }
  await page.locator("#pw-lowercase-min").focus();
  await page.keyboard.press("ArrowUp");
  await check();
  await page.locator("#pw-lowercase-max").focus();
  await page.keyboard.press("ArrowDown");
  await check();
  await setChecked(page.locator("#pw-lookalikes"), true);
  await check();
  await page.locator("#pp-word-list").selectOption("eff-large");
  await setNumber(page.locator("#pp-min-length"), 3);
  await setNumber(page.locator("#pp-max-length"), 3);
  await setRange(page.locator("#pp-words"), 2);
  await setChecked(page.locator("#pp-number"), false);
  await setChecked(page.locator("#pp-symbol"), false);
  await expect(page.locator("#pp-meter-warning")).toBeVisible();
  await check();
  await setChecked(page.locator("#pp-number"), true);
  await setChecked(page.locator("#pp-symbol"), true);
  await page.locator("#pp-symbol-char").selectOption("random-unique");
  await check();
}

for (const width of [1440, 1920, 1100, 1024, 901]) {
  for (const style of STYLES) {
    for (const theme of ["light", "dark"] as const) {
      test(`Uniform card spacing: ${style}/${theme}/${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 1000 });
        await openPage(page);
        await chooseStyle(page, style);
        await chooseTheme(page, theme);
        if (
          capture &&
          shots &&
          width === 1440 &&
          ((style === "calm" && theme === "dark") || (style === "payload" && theme === "light"))
        )
          await page.screenshot({ path: `${shots}/${capture}-${style}-${theme}-full.png`, fullPage: true });
        const cards = await page.evaluate(() =>
          ["pw", "pp"].map((prefix) => {
            const rect = (selector: string) => {
              const el = document.querySelector(selector);
              if (!el) throw new Error(`Missing ${selector}`);
              return el.getBoundingClientRect();
            };
            const card = prefix === "pw" ? "#password" : "#passphrase";
            const result = rect(`${card} .result`);
            const label = rect(`#${prefix}-band`);
            const headline = rect(`#${prefix}-headline`);
            const summary = rect(`#${prefix}-meter summary`);
            return {
              tops: [
                result.top,
                label.top,
                summary.top,
                rect(`#${prefix}-quantum`).top,
                rect(`${card} .control-row`).top,
              ],
              height: result.height,
              resultGap: label.top - result.bottom,
              attackGap:
                summary.top +
                Number.parseFloat(
                  getComputedStyle(document.querySelector(`#${prefix}-meter summary`) as Element).paddingTop,
                ) -
                headline.bottom,
            };
          }),
        );
        console.log(`${style}/${theme}/${width}: ${JSON.stringify(cards)}`);
        const [password, passphrase] = cards;
        if (!password || !passphrase) throw new Error("Missing cards");
        expect(Math.abs(password.height - passphrase.height), "result heights").toBeLessThanOrEqual(1);
        for (let i = 0; i < password.tops.length; i++)
          expect(Math.abs((password.tops[i] ?? 0) - (passphrase.tops[i] ?? 0)), `row ${i}`).toBeLessThanOrEqual(1);
        // Bound the visible gaps, including any reserved text and margins.
        // Allow half a pixel for Firefox's sub-pixel DOMRect rounding.
        for (const card of cards) {
          expect(card.resultGap, "result to strength label: maximum 12px").toBeLessThanOrEqual(12.5);
          expect(card.attackGap, "crack-time line to attack summary: maximum 16px").toBeLessThanOrEqual(16.5);
        }
        await stationaryControls(page);
      });
    }
  }
}

for (const width of [1440, 768, 390]) {
  for (const style of STYLES) {
    for (const theme of ["light", "dark"] as const) {
      // v1.5.1: the open Credits panel spans the footer's full width below the
      // footer's columns, its entries starting at the footer's left edge (in
      // 1.4.1 they were right-aligned under the toggle, which sat on the right).
      test(`Credits full-width panel alignment: ${style}/${theme}/${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 1000 });
        await openPage(page);
        await chooseStyle(page, style);
        await chooseTheme(page, theme);
        const above = () =>
          page.locator("main, main *, .foot-privacy, .foot-meta, .settings-code").evaluateAll((els) =>
            els.map((el) => {
              const r = el.getBoundingClientRect();
              return [r.x, r.y + scrollY, r.width, r.height];
            }),
          );
        await page.locator("#wordlist-credits summary").focus();
        const before = await above();
        await page.locator("#wordlist-credits summary").click();
        // Nothing above the panel moves; on phones the settings code follows the panel.
        const after = await above();
        const code = before.length - 1;
        expect(after.slice(0, code)).toEqual(before.slice(0, code));
        if (width >= 901) expect(after[code]).toEqual(before[code]);
        if (capture && shots && ((style === "calm" && theme === "dark") || (style === "payload" && theme === "light")))
          await page.screenshot({ path: `${shots}/${capture}-${style}-${theme}-credits-${width}.png`, fullPage: true });
        const rows = await page.locator("#wordlist-credits li").evaluateAll((entries) =>
          entries.map((entry) => {
            const footer = document.querySelector(".foot");
            if (!footer) throw new Error("Missing footer");
            const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
            const lefts: number[] = [];
            const split: string[] = [];
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
                const range = document.createRange();
                range.setStart(node, match.index);
                range.setEnd(node, match.index + match[0].length);
                const rects = [...range.getClientRects()];
                if (new Set(rects.map((r) => r.top)).size > 1) split.push(match[0]);
                lefts.push(...rects.map((r) => r.left));
              }
            }
            const panel = entry.parentElement?.getBoundingClientRect();
            const box = footer.getBoundingClientRect();
            return {
              left: Math.min(...lefts),
              footerLeft: box.left,
              panelWidth: panel?.width ?? 0,
              footerWidth: box.width,
              split,
            };
          }),
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        for (const row of rows) {
          expect(row.split).toEqual([]);
          expect(Math.abs(row.left - row.footerLeft), "entry starts at the footer's left edge").toBeLessThanOrEqual(1);
          expect(Math.abs(row.panelWidth - row.footerWidth), "panel spans the footer").toBeLessThanOrEqual(1);
        }
        if (width === 390) await stationaryControls(page);
      });
    }
  }
}
