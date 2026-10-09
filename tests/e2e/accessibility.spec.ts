// N2: exercise the built shared layout in every style, effective theme and
// intro configuration. Each Playwright project supplies its desktop/mobile
// viewport. The intro-off response is the build's only layout difference:
// omission of the complete intro section, before the browser parses it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { contrastRatio } from "../../scripts/lib/style-checks.ts";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, chooseTheme, openPage, STYLES, setNumber } from "./helpers.ts";
import { DIST_DIR } from "./servers.ts";

function color(value: string) {
  const channels = value.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
  if (!channels) throw new Error(`Expected opaque computed colour: ${value}`);
  return { r: Number(channels[1]), g: Number(channels[2]), b: Number(channels[3]), a: 1 };
}
const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function axe(page: Page, state: string) {
  const result = await new AxeBuilder({ page }).withTags(tags).analyze();
  expect(result.violations, state).toEqual([]);
}

// Tab order is the DOM reading order, with one stop for the radio group.
// Test the drawn proxy of hidden checkboxes/radios, not their invisible input.
async function keyboard(page: Page) {
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, summary")]
      .filter((el) => {
        if ((el as HTMLInputElement).disabled || el.hidden || !el.getClientRects().length) return false;
        return !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked);
      })
      .map((el, i) => {
        // Summaries and extra Copy buttons have no id in the shipped markup.
        el.dataset.tabTest = String(i);
        return String(i);
      }),
  );
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
    window.scrollTo(0, 0);
  });
  for (const [reverse, stops] of [
    [false, ids],
    [true, [...ids].reverse()],
  ] as const) {
    for (const [index, id] of stops.entries()) {
      if (!reverse || index > 0) await page.keyboard.press(reverse ? "Shift+Tab" : "Tab");
      const control = page.locator(`[data-tab-test="${id}"]`);
      await expect(control).toBeFocused();
      // Simulate native scrolling that ignores margins; let the actual product
      // focusin listener correct it. In both modes allow its next-frame check
      // to settle before measuring the entire drawn ring.
      await control.evaluate(async (el, forceEdge) => {
        if (forceEdge && !el.closest(".top")) {
          window.scrollBy(0, el.getBoundingClientRect().bottom - innerHeight);
          el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }, process.env.PASSGEN_E2E_FOCUS_EDGE === "1");
      await expect(control).toBeFocused();
      const drawing = await control.evaluate((el) => {
        const input = el as HTMLInputElement;
        const proxy =
          input.type === "radio"
            ? document.querySelector(`label[for="${el.id}"]`)
            : input.type === "checkbox"
              ? el.nextElementSibling
              : el;
        if (!proxy) throw new Error("Missing focus proxy");
        const s = getComputedStyle(proxy);
        const r = proxy.getBoundingClientRect();
        const ringExtent = Number.parseFloat(s.outlineOffset) + Number.parseFloat(s.outlineWidth);
        const header = document.querySelector<HTMLElement>(".top");
        if (!header) throw new Error("Missing header");
        const viewport = window.visualViewport;
        const visibleTop = viewport?.offsetTop ?? 0;
        const headerBottom = Math.max(
          visibleTop,
          getComputedStyle(header).position === "sticky" && !header.contains(el)
            ? header.getBoundingClientRect().bottom
            : visibleTop,
        );
        // Composite translucent ancestor surfaces in the browser's own sRGB
        // canvas, including the header's color-mix(), rather than parsing CSS.
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Missing colour context");
        const ancestors: Element[] = [];
        for (let parent = proxy.parentElement; parent; parent = parent.parentElement) ancestors.unshift(parent);
        for (const parent of ancestors) {
          context.fillStyle = getComputedStyle(parent).backgroundColor;
          context.fillRect(0, 0, 1, 1);
        }
        const pixel = context.getImageData(0, 0, 1, 1).data;
        const surfaceColor = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
        const target = input.type === "radio" ? proxy : input.type === "checkbox" ? el.closest("label") : el;
        const t = target?.getBoundingClientRect();
        return {
          focusColor: s.outlineColor,
          surfaceColor,
          style: s.outlineStyle,
          width: Number.parseFloat(s.outlineWidth),
          offset: Number.parseFloat(s.outlineOffset),
          area:
            (r.width + 2 * Number.parseFloat(s.outlineWidth)) * (r.height + 2 * Number.parseFloat(s.outlineWidth)) -
            r.width * r.height,
          required: 4 * ((input.type === "checkbox" ? 24 : r.width) + (input.type === "checkbox" ? 24 : r.height)),
          headerBottom,
          top: r.top - ringExtent,
          bottom: r.bottom + ringExtent,
          viewport: visibleTop + (viewport?.height ?? innerHeight),
          targetWidth: t?.width ?? 0,
          targetHeight: t?.height ?? 0,
        };
      });
      expect(contrastRatio(color(drawing.focusColor), color(drawing.surfaceColor)), id).toBeGreaterThanOrEqual(3);
      expect(drawing.style, id).toBe("solid");
      expect(drawing.width, id).toBeGreaterThanOrEqual(2);
      expect(drawing.offset, id).toBeGreaterThanOrEqual(2);
      expect(drawing.area, id).toBeGreaterThanOrEqual(drawing.required);
      expect(drawing.top, id).toBeGreaterThanOrEqual(drawing.headerBottom - 1);
      // Native scrolling rounds to physical pixels; allow one CSS pixel.
      expect(drawing.bottom, id).toBeLessThanOrEqual(drawing.viewport + 1);
      expect(drawing.targetWidth, id).toBeGreaterThanOrEqual(24);
      expect(drawing.targetHeight, id).toBeGreaterThanOrEqual(24);
    }
  }
  // Native radio arrows, checkboxes, sliders, number entry, selects, buttons
  // and details all receive real keyboard activation, not synthetic clicks.
  await page.locator("#theme-system").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#theme-light")).toBeChecked();
  await page.keyboard.press("ArrowLeft");
  await page.locator("#pw-lookalikes").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#pw-lookalikes")).toBeChecked();
  await page.keyboard.press("Space");
  await page.locator("#pw-length").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#pw-length-number")).toHaveValue("21");
  await page.keyboard.press("ArrowLeft");
  await page.locator("#pw-length-number").focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Tab");
  await expect(page.locator("#pw-length")).toHaveValue("21");
  await setNumber(page.locator("#pw-length-number"), 20);
  await page.locator("#style").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await page.locator("#pw-regen").focus();
  const previous = await page.locator("#pw-value").innerText();
  await page.keyboard.press("Enter");
  await expect(page.locator("#pw-value")).not.toHaveText(previous);
  await expect(page.locator("#pw-regen")).toBeFocused();
  await page.locator("#pw-meter summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#pw-meter details")).toHaveAttribute("open", "");
}

async function headerPosition(page: Page, sticky: boolean) {
  const header = await page.locator(".top").evaluate((el) => ({
    position: getComputedStyle(el).position,
    height: el.getBoundingClientRect().height,
    configuredHeight: Number.parseFloat(getComputedStyle(el).getPropertyValue("--header-h")),
    scrollPadding: Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop),
  }));
  expect(header.position).toBe(sticky ? "sticky" : "relative");
  if (sticky) {
    expect(header.height).toBe(header.configuredHeight);
    expect(header.scrollPadding).toBeGreaterThanOrEqual(header.height + 16);
  }
}

async function reflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, label, summary, .value, .notice, .copy-feedback")]
      .filter((el) => el.getClientRects().length && getComputedStyle(el).position !== "absolute")
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      .map((el) => el.id || el.className || el.tagName),
  );
  expect(clipped).toEqual([]);
}

// Every combination is one long test. CI shards them separately from the rest
// of the suite by this tag (see .github/workflows/ci.yml), because Playwright
// cuts the ordered test list into contiguous shards and this file sorts first.
for (const style of STYLES) {
  for (const [theme, scheme] of [
    ["system", "light"],
    ["system", "dark"],
    ["light", "dark"],
    ["dark", "light"],
  ] as const) {
    for (const intro of [true, false]) {
      test(`accessibility ${style} / ${theme} / OS ${scheme} / intro ${intro}`, { tag: "@a11y-matrix" }, async ({
        page,
      }) => {
        test.setTimeout(180_000);
        if (!intro) {
          const html = readFileSync(join(DIST_DIR, "index.html"), "utf8");
          const off = html.replace(/<section class="intro"[^>]*>[\s\S]*?<\/section>/, "");
          expect(off).not.toBe(html);
          await page.route("**/", async (route) => {
            if (route.request().isNavigationRequest())
              await route.fulfill({ response: await route.fetch(), body: off });
            else await route.continue();
          });
        }
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "clipboard", {
            value: {
              writeText: async () => {
                throw new Error("Clipboard unavailable");
              },
            },
          });
        });
        if (!test.info().project.name.includes("mobile")) await page.setViewportSize({ width: 1280, height: 800 });
        await openPage(page);
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        await chooseStyle(page, style);
        await chooseTheme(page, theme);
        await expect(page.locator(".intro")).toHaveCount(intro ? 1 : 0);
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        await expect(page.locator("h1")).toHaveCount(1);
        expect(
          await page.locator("h1, h2, h3, h4, h5, h6").evaluateAll((els) => {
            const levels = els.map((el) => Number(el.tagName.slice(1)));
            return levels.every((level, i) => i === 0 || level <= (levels[i - 1] ?? 0) + 1);
          }),
        ).toBe(true);
        const initial = page.viewportSize();
        if (!initial) throw new Error("Missing viewport");
        await headerPosition(page, initial.width >= 900 && initial.height >= 500);
        await axe(page, "initial");
        await keyboard(page);
        // Keyboard smoke changes theme/style; restore the combination under audit.
        await chooseStyle(page, style);
        await chooseTheme(page, theme);
        for (const summary of await page.locator("summary").all()) {
          if (!(await summary.evaluate((el) => el.parentElement?.hasAttribute("open")))) await summary.click();
        }
        await axe(page, "expanded attack scenarios");
        await setNumber(page.locator("#pp-words-number"), 2);
        await setNumber(page.locator("#pp-min-length"), 9);
        await expect(page.locator("#pp-meter-warning")).toBeVisible();
        await axe(page, "R13 warning");
        await setNumber(page.locator("#pw-lowercase-min"), 21);
        await expect(page.locator("#pw-notice")).toContainText("Min must be a whole number from 0 to 20.");
        await expect(page.locator("#pw-lowercase-min")).toHaveAttribute("aria-invalid", "true");
        await expect(page.locator("#pw-lowercase-min")).toHaveAccessibleDescription(/Min/);
        await axe(page, "invalid settings");
        await setNumber(page.locator("#pw-lowercase-min"), 1);
        await page.locator("#save-settings").click();
        const saved = page.locator("#save-settings-status");
        await expect(saved).toContainText("Saved");
        await expect(saved).toHaveAttribute("aria-live", "polite");
        await expect(page.locator("#save-settings")).toHaveClass(/is-done/);
        await axe(page, "saved");
        await page.locator("#reset-settings").click();
        await expect(saved).toContainText("Reset to defaults");
        await axe(page, "reset");
        for (const link of await page.locator("a[href]").all()) {
          await expect(link).toHaveAccessibleName(/.+/);
          await expect(link).toHaveAttribute("rel", "noopener noreferrer");
        }
        await page.locator("#pw-copy").focus();
        await page.keyboard.press("Enter");
        await expect(page.locator("#pw-copy")).toHaveText("Copy failed");
        await expect(page.locator("#pw-copy")).toBeFocused();
        const feedback = page.locator("#pw-copy").locator("..").getByRole("status");
        await expect(feedback).toContainText("copy it manually");
        await expect(feedback).toHaveAttribute("aria-live", "polite");
        await axe(page, "copy failure");
        const fallback = page.getByRole("button", { name: "Select main password text" });
        await fallback.focus();
        await page.keyboard.press("Enter");
        await expect(page.locator("#pw-value")).toBeFocused();
        expect(await page.evaluate(() => getSelection()?.toString())).toBe(await page.locator("#pw-value").innerText());
        await axe(page, "clipboard fallback");
        for (const input of await page.locator("input, select").all()) {
          await expect(input).toHaveAccessibleName(/.+/);
        }
        expect(
          await page.evaluate(
            () => document.getAnimations().filter((animation) => animation.playState === "running").length,
          ),
        ).toBe(0);
        // 200% of the 1280x800 desktop viewport is 640x400 CSS pixels.
        // Also exercise 320 CSS px, independently of the project's device.
        const original = page.viewportSize();
        if (!original) throw new Error("Missing viewport");
        for (const viewport of [
          { width: 640, height: 400 },
          { width: 320, height: original.height },
        ]) {
          await page.setViewportSize(viewport);
          await headerPosition(page, false);
          await reflow(page);
          // A test-only user stylesheet bypasses CSP, as accessibility user
          // overrides do; no inline style is added to the product.
          await page.evaluate(() => {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(`
              * { line-height: 1.5 !important; letter-spacing: .12em !important;
                  word-spacing: .16em !important; }
              p { margin-bottom: 2em !important; }
            `);
            document.adoptedStyleSheets = [sheet];
          });
          await reflow(page);
          await axe(page, `spacing and reflow at ${viewport.width}x${viewport.height}px`);
        }
      });
    }
  }
}

test("focus helper leaves visible rings alone and instantly corrects clipped keyboard focus", async ({ page }) => {
  await openPage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Tab");
  const control = page.locator("#save-settings");
  const result = await control.evaluate(async (el) => {
    const element = el as HTMLElement;
    element.scrollIntoView({ block: "center" });
    element.focus();
    const frames = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await frames();
    const original = element.scrollIntoView.bind(element);
    const calls: ScrollIntoViewOptions[] = [];
    element.scrollIntoView = (options) => {
      if (typeof options === "object") calls.push(options);
      original(options);
    };
    try {
      const visibleScroll = scrollY;
      element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await frames();
      const visibleCalls = calls.length;
      const unchanged = scrollY === visibleScroll;
      window.scrollBy(0, element.getBoundingClientRect().bottom - innerHeight);
      element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await frames();
      return { visibleCalls, unchanged, calls, retainedFocus: document.activeElement === element };
    } finally {
      element.scrollIntoView = original;
    }
  });
  expect(result.visibleCalls).toBe(0);
  expect(result.unchanged).toBe(true);
  expect(result.calls).toEqual([{ block: "nearest", inline: "nearest", behavior: "instant" }]);
  expect(result.retainedFocus).toBe(true);
});
