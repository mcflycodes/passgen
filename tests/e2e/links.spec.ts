// The page's two outward links (decision 0005, point 5) and the version: the
// footer's meta line shows the package version, links "Apache-2.0" to the
// configured license and, after Credits, "GitHub" to the configured
// repository (v1.5.1: the header no longer carries it). Both are plain
// anchors with rel="noopener noreferrer" and the configured URL exactly,
// cause no request at load, and are focusable with a visible ring in every
// style and theme. The build leaves a link out when its URL is empty
// (tests/unit/page-template.test.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../src/config/validate.ts";
import { expect, expectNoRequestsAfterLoad, test } from "./fixtures.ts";
import { chooseStyle, chooseTheme, openPage, STYLES, THEMES } from "./helpers.ts";
import { ORIGINS } from "./servers.ts";

const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")) as {
  version: string;
};

test.describe("repository and license links", () => {
  test.skip(config.links.repoUrl === "" || config.links.licenseUrl === "", "the shipped configuration sets both links");

  test("render from the configuration as plain anchors in the footer's meta line", async ({ page, watched }) => {
    await openPage(page);
    const repo = page.locator("#repo-link");
    await expect(repo).toHaveAttribute("href", config.links.repoUrl);
    await expect(repo).toHaveAttribute("rel", "noopener noreferrer");
    await expect(repo).not.toHaveAttribute("target", /.*/);
    await expect(repo).toHaveText("GitHub");
    await expect(repo).toHaveAccessibleName("GitHub");
    await expect(repo).toBeVisible();
    expect(await repo.evaluate((el) => el.closest("footer") !== null)).toBe(true);
    await expect(page.locator(".top a")).toHaveCount(0);
    // The meta line reads: version · Apache-2.0 · Credits · GitHub.
    expect((await page.locator(".foot-meta").allInnerTexts()).join(" ").replace(/\s+/g, " ").trim()).toBe(
      `v${version} · Apache-2.0 · Credits · GitHub`,
    );

    const license = page.locator("#license-link");
    await expect(license).toHaveAttribute("href", config.links.licenseUrl);
    await expect(license).toHaveAttribute("rel", "noopener noreferrer");
    await expect(license).not.toHaveAttribute("target", /.*/);
    await expect(license).toHaveText("Apache-2.0");
    await expect(license).toHaveAccessibleName("Apache-2.0 license");
    await expect(license).toBeVisible();
    expect(await license.evaluate((el) => el.closest("footer") !== null)).toBe(true);
    await expect(page.locator(".foot-version")).toHaveText(`v${version}`);
    expect(await page.locator("a[href]").count()).toBe(12);

    // From 1200px the meta line is a column right of the privacy line; narrower footers stack it below.
    const text = await page.locator(".foot-privacy").boundingBox();
    const meta = await page.locator(".foot-meta").first().boundingBox();
    if (!text || !meta) throw new Error("footer not rendered");
    if ((page.viewportSize()?.width ?? 0) >= 1200) expect(meta.x).toBeGreaterThan(text.x + text.width - 1);
    else expect(meta.y).toBeGreaterThanOrEqual(text.y + text.height - 1);

    // Anchors fetch nothing: no request at load beyond the page's own files, and none after.
    for (const url of watched.requests) expect(new URL(url).origin).toBe(ORIGINS.root);
    await expectNoRequestsAfterLoad(page, watched);
    expect(watched.problems).toEqual([]);
    expect(await watched.violations()).toEqual([]);
  });

  test("are reachable by keyboard with a visible focus ring in every style and theme", async ({ page }) => {
    // Fifteen style and theme combinations; on phones each choice also opens
    // and closes the header's Appearance panel, as a user would (v1.5.1).
    test.setTimeout(90_000);
    await openPage(page);
    for (const style of STYLES) {
      await chooseStyle(page, style);
      for (const theme of THEMES) {
        await chooseTheme(page, theme);
        // The license link comes just before the Credits summary and the
        // repository link just after it, so one Shift+Tab or Tab from the
        // summary reaches each; a real key press is what makes the ring
        // show (:focus-visible).
        for (const [id, key] of [
          ["repo-link", "Tab"],
          ["license-link", "Shift+Tab"],
        ] as const) {
          const link = page.locator(`#${id}`);
          await page.locator("#wordlist-credits summary").focus();
          await page.keyboard.press(key);
          await expect(link).toBeFocused();
          const ring = await link.evaluate((el) => {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return {
              style: s.outlineStyle,
              width: Number.parseFloat(s.outlineWidth),
              height: r.height,
              width24: r.width,
              decoration: s.textDecorationLine,
            };
          });
          expect(ring.style, `${style}/${theme}/${id}`).toBe("solid");
          expect(ring.width, `${style}/${theme}/${id}`).toBeGreaterThanOrEqual(2);
          expect(ring.height, `${style}/${theme}/${id}`).toBeGreaterThanOrEqual(24);
          expect(ring.width24, `${style}/${theme}/${id}`).toBeGreaterThanOrEqual(24);
          expect(ring.decoration, `${style}/${theme}/${id}`).toContain("underline");
        }
      }
    }
  });
});
