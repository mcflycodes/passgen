import { AxeBuilder } from "@axe-core/playwright";
import { config, wordListCredits } from "../../src/config/validate.ts";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, chooseTheme, openPage, STYLES } from "./helpers.ts";

for (const width of [1440, 390]) {
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
            ...[...footer.querySelectorAll(".foot-text, .foot-meta, summary")].map(
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
            .locator("main, main *, .foot-text, .foot-version, #license-link, #wordlist-credits summary")
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
        console.log(`${style}/${theme}/${phone ? 390 : 1440}: panel=${panel.width}, footer=${footer.width}`);
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
        const result = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        expect(result.violations).toEqual([]);
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

for (const style of STYLES) {
  test(`Collapsed Credits keeps main's intrinsic flex wrap: ${style}`, async ({ page }) => {
    await openPage(page);
    await chooseStyle(page, style);
    // A separate, inert footer supplies the original flex layout as an oracle.
    // Serve the stylesheet externally to respect the page's CSP.
    await page.route("**/credits-baseline.css", (route) =>
      route.fulfill({
        contentType: "text/css",
        body: `
        .credits-baseline { container-type:normal; display:flex; flex-wrap:wrap; justify-content:space-between; gap:12px 32px; }
        .credits-baseline .foot-text { flex:1 1 420px; margin-right:0; grid-column:auto; }
        .credits-baseline .foot-meta { grid-template-columns:repeat(5,auto); padding-bottom:0; flex:0 1 auto; }
        .credits-baseline .wordlist-credits::details-content { display:block; content-visibility:hidden; grid-column:auto; contain:none; }
        .credits-baseline .wordlist-credits ul { position:static; width:0; min-width:100%; margin-top:0; }
      `,
      }),
    );
    await page.addStyleTag({ url: "/credits-baseline.css" });
    await page.locator(".foot").evaluate((footer) => {
      const clone = footer.cloneNode(true) as HTMLElement;
      clone.classList.add("credits-baseline");
      clone.setAttribute("inert", "");
      clone.setAttribute("aria-hidden", "true");
      for (const el of clone.querySelectorAll("[id]")) el.removeAttribute("id");
      clone.querySelector(".foot-meta")?.append(clone.querySelector("details") as HTMLElement);
      footer.after(clone);
    });
    for (const theme of ["light", "dark"] as const) {
      await chooseTheme(page, theme);
      for (const width of [768, 760, 800, 1024, 1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const boxes = await page.evaluate(() => {
          const box = (selector: string) => {
            const footer = document.querySelector(selector) as HTMLElement;
            const origin = footer.getBoundingClientRect();
            return [".foot-text", ".foot-meta"].map((child) => {
              const rect = (footer.querySelector(child) as HTMLElement).getBoundingClientRect();
              if (child === ".foot-meta") {
                const cells = [
                  ...footer.querySelectorAll(".foot-version, .foot-sep, #license-link, .foot-link, summary"),
                ].map((el) => el.getBoundingClientRect());
                const left = Math.min(...cells.map((r) => r.left));
                const right = Math.max(...cells.map((r) => r.right));
                return { x: left - origin.x, y: rect.y - origin.y, width: right - left, height: rect.height };
              }
              return { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height };
            });
          };
          return { actual: box(".foot:not(.credits-baseline)"), expected: box(".credits-baseline") };
        });
        for (let i = 0; i < boxes.actual.length; i++) {
          const actual = boxes.actual[i];
          const expected = boxes.expected[i];
          if (!actual || !expected) throw new Error("Missing footer row box");
          for (const key of ["x", "y", "width", "height"] as const) {
            expect(Math.abs(actual[key] - expected[key]), `${style}/${theme}/${width}/${i}/${key}`).toBeLessThanOrEqual(
              1,
            );
          }
        }
        const above = () =>
          page
            .locator(
              "main, main *, .foot:not(.credits-baseline) .foot-text, .foot:not(.credits-baseline) .foot-version, .foot:not(.credits-baseline) .foot-link, .foot:not(.credits-baseline) summary",
            )
            .evaluateAll((nodes) =>
              nodes.map((node) => {
                const rect = node.getBoundingClientRect();
                return { x: rect.x, y: rect.y + scrollY, width: rect.width, height: rect.height };
              }),
            );
        const summary = page.locator("#wordlist-credits summary");
        await summary.focus();
        const before = await above();
        await page.keyboard.press("Enter");
        expect(await above()).toEqual(before);
        await page.keyboard.press("Space");
        expect(await above()).toEqual(before);
      }
    }
  });
}
