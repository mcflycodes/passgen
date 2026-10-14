import { AxeBuilder } from "@axe-core/playwright";
import { config, wordListCredits } from "../../src/config/validate.ts";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, chooseTheme, openPage, STYLES } from "./helpers.ts";

for (const width of [1440, 768, 390]) {
  for (const style of STYLES) {
    for (const theme of ["light", "dark"] as const) {
      test(`Credits readable panel: ${style}/${theme}/${width}`, async ({ page }) => {
        const phone = width === 390;
        await page.setViewportSize({ width, height: phone ? 844 : 1000 });
        await openPage(page);
        await chooseStyle(page, style);
        await chooseTheme(page, theme);
        const details = page.locator("#wordlist-credits");
        const summary = details.locator("summary");
        await expect(details).not.toHaveAttribute("open", "");
        const collapsedSpacing = await page.locator(".foot").evaluate((footer) => {
          const bottom = Math.max(
            ...[...footer.querySelectorAll(".foot-privacy, .foot-meta, summary, .settings-code")].map(
              (el) => el.getBoundingClientRect().bottom,
            ),
          );
          return {
            actual: footer.getBoundingClientRect().bottom,
            expected: bottom + Number.parseFloat(getComputedStyle(footer).paddingBottom),
          };
        });
        expect(Math.abs(collapsedSpacing.actual - collapsedSpacing.expected)).toBeLessThanOrEqual(1);
        await page.locator("#license-link").focus();
        await page.keyboard.press("Tab");
        await expect(summary).toBeFocused();
        const above = () =>
          page
            .locator("main, main *, .foot-privacy, .foot-version, #license-link, #wordlist-credits summary")
            .evaluateAll((nodes) =>
              nodes.map((node) => {
                const r = node.getBoundingClientRect();
                return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height };
              }),
            );
        const before = await above();
        await page.keyboard.press("Enter");
        await expect(details).toHaveAttribute("open", "");
        expect(await above()).toEqual(before);
        const panel = await details.locator("ul").boundingBox();
        const footer = await page.locator(".foot").boundingBox();
        if (!panel || !footer) throw new Error("Missing Credits panel or footer");
        expect(panel.width).toBeGreaterThanOrEqual(footer.width * 0.8);
        expect(panel.x).toBeGreaterThanOrEqual(footer.x - 1);
        expect(panel.x + panel.width).toBeLessThanOrEqual(footer.x + footer.width + 1);
        const rowBottom = Math.max(...before.slice(-4).map((r) => r.y + r.height));
        expect(panel.y + (await page.evaluate(() => scrollY))).toBeGreaterThanOrEqual(rowBottom);
        await expect(details.locator("li")).toHaveCount(config.passphrase.wordLists.offered.length);
        for (const credit of wordListCredits(config)) {
          const entry = details.locator(`[data-word-list="${credit.id}"]`);
          await expect(entry).toContainText(credit.name);
          await expect(entry).toContainText(credit.source.author);
          await expect(entry).toContainText(`${credit.count.toLocaleString("en-US")} usable words`);
          await expect(entry.getByRole("link", { name: credit.source.license, exact: true })).toHaveAttribute(
            "href",
            credit.source.licenseUrl,
          );
          await expect(entry.getByRole("link", { name: "Source", exact: true })).toHaveAttribute(
            "href",
            credit.source.url,
          );
          const bounds = await entry.boundingBox();
          expect(bounds?.height).toBeLessThanOrEqual(phone ? 110 : 50);
          // A Range for each word must occupy one line, even on a phone.
          const splitWords = await entry.evaluate((el) => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const split: string[] = [];
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
                const range = document.createRange();
                range.setStart(node, match.index);
                range.setEnd(node, match.index + match[0].length);
                if (new Set([...range.getClientRects()].map((r) => r.top)).size > 1) split.push(match[0]);
              }
            }
            return split;
          });
          expect(splitWords).toEqual([]);
          if (!phone) {
            const lines = await entry.evaluate((el, name) => {
              const node = el.firstChild;
              if (!node) throw new Error("Missing credit name");
              const range = document.createRange();
              range.setStart(node, 0);
              range.setEnd(node, name.length);
              return range.getClientRects().length;
            }, credit.name);
            expect(lines).toBe(1);
            const licenseLines = await entry
              .getByRole("link", { name: credit.source.license, exact: true })
              .evaluate((el) => {
                const range = document.createRange();
                range.selectNodeContents(el);
                return range.getClientRects().length;
              });
            expect(licenseLines).toBe(1);
          }
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        // Audit from the top of the page, as the accessibility matrix does: the
        // header is pinned at every width (v1.5.1) and covers whatever is
        // scrolled beneath it, which target-size would report as obscured.
        const scrolled = await page.evaluate(() => scrollY);
        await page.evaluate(() => window.scrollTo(0, 0));
        const result = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        expect(result.violations).toEqual([]);
        await page.evaluate((y) => window.scrollTo(0, y), scrolled);
        if (phone) {
          // Emergency wrapping is allowed only for a word wider than the panel.
          const wrapped = await details
            .locator("li")
            .first()
            .evaluate((entry) => {
              const word = document.createTextNode(` ${"X".repeat(500)}`);
              entry.append(word);
              const range = document.createRange();
              range.setStart(word, 1);
              range.setEnd(word, word.length);
              const lines = new Set([...range.getClientRects()].map((rect) => rect.top)).size;
              const fits = document.documentElement.scrollWidth <= innerWidth;
              word.remove();
              return { lines, fits };
            });
          expect(wrapped.lines).toBeGreaterThan(1);
          expect(wrapped.fits).toBe(true);
        }
        await summary.focus();
        await page.keyboard.press("Space");
        await expect(details).not.toHaveAttribute("open", "");
        expect(await above()).toEqual(before);
      });
    }
  }
}
