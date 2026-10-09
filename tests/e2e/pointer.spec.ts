// Decorative backgrounds and the shared pointer effect (R4c): only opted-in
// styles react, only custom properties on the root are written, and the
// effect stops under reduced motion, without a fine pointer and in a hidden
// tab.

import { config, configuredLinks } from "../../src/config/validate.ts";
import { collectLiveDom, liveDomProblems } from "./dom-checks.ts";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, openPage, STYLES } from "./helpers.ts";

/** The configured links, the only addresses the page may carry (decision 0005, point 5). */
const ALLOWED_LINKS = configuredLinks(config);

const POINTER_PROPS = ["--px", "--py", "--pxs", "--pys", "--pxt", "--pyt", "--pxn", "--pyn"];

const rootProperties = (page: import("@playwright/test").Page) =>
  page.evaluate((props) => {
    const style = document.documentElement.style;
    return Object.fromEntries(props.map((p) => [p, style.getPropertyValue(p)]).filter(([, v]) => v !== ""));
  }, POINTER_PROPS);

const inlineStyleAttributes = (page: import("@playwright/test").Page) =>
  page.evaluate(() => [...document.querySelectorAll("[style]")].map((el) => el.tagName.toLowerCase()));

const sweep = async (page: import("@playwright/test").Page) => {
  for (let i = 0; i < 10; i += 1) await page.mouse.move(100 + i * 40, 150 + i * 20);
  await page.waitForTimeout(150);
};

test.describe("pointer effect", () => {
  test("nothing is written on load, and Calm (static background) never reacts", async ({ page }) => {
    await openPage(page);
    // The range inputs carry their fill; nothing else has inline style, and the root gets none.
    expect(await inlineStyleAttributes(page)).toEqual(["input", "input"]);
    await sweep(page);
    expect(await rootProperties(page)).toEqual({});
    expect(await inlineStyleAttributes(page)).toEqual(["input", "input"]);
  });

  test("an opted-in style follows the pointer with custom properties on the root only", async ({ page }) => {
    const mobile = test.info().project.name.includes("mobile");
    await openPage(page);
    await chooseStyle(page, "payload");
    await sweep(page);
    const written = await rootProperties(page);
    if (mobile) {
      // No hover-capable fine pointer: the background stays at rest.
      expect(written).toEqual({});
      return;
    }
    expect(Object.keys(written).sort()).toEqual([...POINTER_PROPS].sort());
    expect(written["--pxs"]).toMatch(/^\d+(\.\d+)?%$/);
    expect(Number.parseFloat(written["--pxn"] ?? "")).toBeGreaterThan(0);
    expect(await inlineStyleAttributes(page)).toEqual(["html", "input", "input"]);
    // Switching to a static style clears the properties and leaves no style attribute on the root.
    await chooseStyle(page, "calm");
    expect(await rootProperties(page)).toEqual({});
    expect(await inlineStyleAttributes(page)).toEqual(["input", "input"]);
    expect(liveDomProblems("index.html", await collectLiveDom(page), ALLOWED_LINKS)).toEqual([]);
    await sweep(page);
    expect(await rootProperties(page)).toEqual({});
  });

  test("reduced motion stops the effect, and lifting it resumes", async ({ page }) => {
    test.skip(test.info().project.name.includes("mobile"), "touch devices never run the effect");
    await openPage(page);
    await chooseStyle(page, "green");
    await sweep(page);
    expect(Object.keys(await rootProperties(page))).not.toEqual([]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => rootProperties(page)).toEqual({});
    await sweep(page);
    expect(await rootProperties(page)).toEqual({});
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await sweep(page);
    expect(Object.keys(await rootProperties(page))).not.toEqual([]);
  });

  test("a hidden tab clears the effect", async ({ page }) => {
    test.skip(test.info().project.name.includes("mobile"), "touch devices never run the effect");
    await openPage(page);
    await chooseStyle(page, "purple");
    await sweep(page);
    expect(Object.keys(await rootProperties(page))).not.toEqual([]);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => rootProperties(page)).toEqual({});
    await sweep(page);
    expect(await rootProperties(page)).toEqual({});
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sweep(page);
    expect(Object.keys(await rootProperties(page))).not.toEqual([]);
  });

  test("rest tokens outside 0..1 are held to the bounds at write time", async ({ page }) => {
    test.skip(test.info().project.name.includes("mobile"), "touch devices never run the effect");
    await openPage(page);
    // A hostile style's rest tokens, set through the CSSOM where the effect reads them.
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--fx-rest-x", "999");
      document.documentElement.style.setProperty("--fx-rest-y", "-5");
    });
    await chooseStyle(page, "green");
    await page.mouse.move(5, 5);
    await page.waitForTimeout(50);
    const written = await rootProperties(page);
    expect(Object.keys(written).length).toBe(POINTER_PROPS.length);
    for (const [prop, value] of Object.entries(written)) {
      const number = Number.parseFloat(String(value));
      expect(number, `${prop}=${value}`).toBeLessThanOrEqual(prop.endsWith("n") ? 1 : 100);
      expect(number, `${prop}=${value}`).toBeGreaterThanOrEqual(0);
    }
    await page.evaluate(() => {
      document.documentElement.style.removeProperty("--fx-rest-x");
      document.documentElement.style.removeProperty("--fx-rest-y");
    });
    await sweep(page);
    expect(liveDomProblems("index.html", await collectLiveDom(page), ALLOWED_LINKS)).toEqual([]);
  });

  for (const style of STYLES) {
    test(`the live-DOM gate holds after real pointer movement in ${style}`, async ({ page }) => {
      await openPage(page);
      await chooseStyle(page, style);
      await sweep(page);
      await page.mouse.move(640, 360);
      await page.waitForTimeout(100);
      expect(liveDomProblems("index.html", await collectLiveDom(page), ALLOWED_LINKS)).toEqual([]);
      // Only <html> (pointer) and the range inputs (slider fill) may carry inline style.
      expect(await inlineStyleAttributes(page)).toEqual(expect.arrayContaining(["input", "input"]));
      for (const tag of await inlineStyleAttributes(page)) expect(["html", "input"]).toContain(tag);
    });
  }
});
