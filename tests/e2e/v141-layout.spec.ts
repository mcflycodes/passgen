import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, chooseTheme, openPage, STYLES, setNumber, setRange } from "./helpers.ts";

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
  await page.locator("#pw-meter summary").click();
  await expect(page.locator("#pw-scenarios")).toContainText("NTLM search capped");
  await page.locator("#pw-meter summary").click();
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
  await page.locator("#pw-lookalikes").check();
  await check();
  await page.locator("#pp-word-list").selectOption("eff-large");
  await setNumber(page.locator("#pp-min-length"), 3);
  await setNumber(page.locator("#pp-max-length"), 3);
  await setRange(page.locator("#pp-words"), 2);
  await page.locator("#pp-number").uncheck();
  await page.locator("#pp-symbol").uncheck();
  await expect(page.locator("#pp-meter-warning")).toBeVisible();
  await check();
  await page.locator("#pp-number").check();
  await page.locator("#pp-symbol").check();
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
        for (const card of cards) {
          expect(card.resultGap, "result to strength label: maximum 12px").toBeLessThanOrEqual(12);
          expect(card.attackGap, "crack-time line to attack summary: maximum 16px").toBeLessThanOrEqual(16);
        }
        await stationaryControls(page);
      });
    }
  }
}

for (const width of [1440, 768, 390]) {
  for (const style of STYLES) {
    for (const theme of ["light", "dark"] as const) {
      test(`Credits right alignment: ${style}/${theme}/${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 1000 });
        await openPage(page);
        await chooseStyle(page, style);
        await chooseTheme(page, theme);
        const above = () =>
          page
            .locator("main, main *, .foot-text, .foot-meta > :not(details), #wordlist-credits summary")
            .evaluateAll((els) =>
              els.map((el) => {
                const r = el.getBoundingClientRect();
                return [r.x, r.y + scrollY, r.width, r.height];
              }),
            );
        await page.locator("#wordlist-credits summary").focus();
        const before = await above();
        await page.locator("#wordlist-credits summary").click();
        expect(await above()).toEqual(before);
        if (capture && shots && ((style === "calm" && theme === "dark") || (style === "payload" && theme === "light")))
          await page.screenshot({ path: `${shots}/${capture}-${style}-${theme}-credits-${width}.png`, fullPage: true });
        const rows = await page.locator("#wordlist-credits li").evaluateAll((entries) =>
          entries.map((entry) => {
            const toggle = document.querySelector(".foot-meta");
            if (!toggle) throw new Error("Missing toggle group");
            const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
            const rights: number[] = [];
            const split: string[] = [];
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
                const range = document.createRange();
                range.setStart(node, match.index);
                range.setEnd(node, match.index + match[0].length);
                const rects = [...range.getClientRects()];
                if (new Set(rects.map((r) => r.top)).size > 1) split.push(match[0]);
                rights.push(...rects.map((r) => r.right));
              }
            }
            return { right: Math.max(...rights), toggle: toggle.getBoundingClientRect().right, split };
          }),
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        for (const row of rows) {
          expect(row.split).toEqual([]);
          expect(
            Math.abs(row.right - row.toggle),
            "visible entry right edge matches Credits toggle group",
          ).toBeLessThanOrEqual(1);
        }
        if (width === 390) await stationaryControls(page);
      });
    }
  }
}
