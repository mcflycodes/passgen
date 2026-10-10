// The page's two outward links (decision 0005, point 5) and the version: the
// header links to the configured repository beside the Style control, the
// footer's right side shows the package version and links "Apache-2.0" to
// the configured license. Both are plain anchors with rel="noopener
// noreferrer" and the configured URL exactly, cause no request at load, and
// are focusable with a visible ring in every style and theme. The build
// leaves a link out when its URL is empty (tests/unit/page-template.test.ts).

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

  test("render from the configuration as plain anchors, beside the Style control and in the footer", async ({
    page,
    watched,
  }) => {
    await openPage(page);
    const repo = page.locator("#repo-link");
    await expect(repo).toHaveAttribute("href", config.links.repoUrl);
    await expect(repo).toHaveAttribute("rel", "noopener noreferrer");
    await expect(repo).not.toHaveAttribute("target", /.*/);
    await expect(repo).toHaveText("");
    await expect(repo).toHaveAccessibleName("GitHub");
    await expect(repo).toHaveAttribute("title", "GitHub");
    await expect(repo.locator("svg")).toHaveAttribute("aria-hidden", "true");
    await expect(repo.locator("svg")).toHaveAttribute("fill", "currentColor");
    await expect(repo.locator("svg path")).toHaveAttribute("d", /.+/);
    await expect(repo).toBeVisible();
    expect(await repo.evaluate((el) => el.closest(".top-controls") !== null)).toBe(true);
    expect(await repo.evaluate((el) => el.nextElementSibling?.classList.contains("style-control"))).toBe(true);

    const license = page.locator("#license-link");
    await expect(license).toHaveAttribute("href", config.links.licenseUrl);
    await expect(license).toHaveAttribute("rel", "noopener noreferrer");
    await expect(license).not.toHaveAttribute("target", /.*/);
    await expect(license).toHaveText("Apache-2.0");
    await expect(license).toHaveAccessibleName("Apache-2.0 license");
    await expect(license).toBeVisible();
    expect(await license.evaluate((el) => el.closest("footer") !== null)).toBe(true);
    await expect(page.locator(".foot-version")).toHaveText(`v${version}`);
    expect(await page.locator("a[href]").count()).toBe(2);

    // Wide footers put the meta on the right; narrow ones stack it below the text.
    const text = await page.locator(".foot-text").boundingBox();
    const meta = await page.locator(".foot-meta").boundingBox();
    if (!text || !meta) throw new Error("footer not rendered");
    if ((page.viewportSize()?.width ?? 0) >= 900) expect(meta.x).toBeGreaterThan(text.x + text.width - 1);
    else expect(meta.y).toBeGreaterThanOrEqual(text.y + text.height - 1);

    // Anchors fetch nothing: no request at load beyond the page's own files, and none after.
    for (const url of watched.requests) expect(new URL(url).origin).toBe(ORIGINS.root);
    await expectNoRequestsAfterLoad(page, watched);
    expect(watched.problems).toEqual([]);
    expect(await watched.violations()).toEqual([]);
  });

  test("are reachable by keyboard with a visible focus ring in every style and theme", async ({ page }) => {
    await openPage(page);
    for (const style of STYLES) {
      await chooseStyle(page, style);
      for (const theme of THEMES) {
        await chooseTheme(page, theme);
        // The repository link is the page's first focusable element and the
        // license link follows the Reset button, so one Tab reaches each; a
        // real key press is what makes the ring show (:focus-visible).
        for (const [id, from] of [
          ["repo-link", null],
          ["license-link", "#reset-settings"],
        ] as const) {
          const link = page.locator(`#${id}`);
          if (from === null) {
            // Start sequential focus from the body, as tests/e2e/accessibility.spec.ts does.
            await page.evaluate(() => {
              document.body.tabIndex = -1;
              document.body.focus();
              document.body.removeAttribute("tabindex");
            });
          } else await page.locator(from).focus();
          await page.keyboard.press("Tab");
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
          if (id === "license-link") expect(ring.decoration, `${style}/${theme}/${id}`).toContain("underline");
        }
      }
    }
  });
});
