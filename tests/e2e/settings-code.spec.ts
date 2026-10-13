// The settings code: a code got on one page and applied in a fresh browser
// context reproduces every setting, the theme, the style and the strength
// shown; applying writes nothing to any storage, touches neither the URL nor
// history and makes no request; a bad code changes nothing and says why, to
// screen readers too; and neither the code nor any status ever contains a
// generated value.

import type { Browser, Page } from "@playwright/test";
import { BASELINE, encodeSettingsCode } from "../../src/core/settings-code.ts";
import { CODE_APPLIED_STATUS, CODE_ERROR_STATUS, CODE_READY_STATUS } from "../../src/ui/settings-code.ts";
import { expect, expectNoRequestsAfterLoad, test } from "./fixtures.ts";
import { chooseStyle, chooseTheme, openPage, setNumber, setRange } from "./helpers.ts";

const get = (page: Page) => page.locator("#get-settings-code");
const shown = (page: Page) => page.locator("#settings-code-value");
const copy = (page: Page) => page.locator("#copy-settings-code");
const input = (page: Page) => page.locator("#settings-code-input");
const apply = (page: Page) => page.locator("#apply-settings-code");
const status = (page: Page) => page.locator("#settings-code-status");

/** Everything a user can see of the settings, and the strength each generator shows. */
function state(page: Page) {
  return page.evaluate(() => {
    const out: Record<string, string | boolean> = {};
    for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "#password input, #passphrase input, #passphrase select, #style, input[name=theme]",
    )) {
      out[el.id] = el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type) ? el.checked : el.value;
      out[`${el.id}:disabled`] = el.disabled;
    }
    const root = document.documentElement;
    out.theme = root.dataset.theme ?? "";
    out.style = root.dataset.style ?? "";
    for (const id of ["pw-bits", "pw-band", "pp-bits", "pp-band", "pw-notice", "pp-notice"])
      out[id] = document.getElementById(id)?.textContent ?? "";
    return out;
  });
}

/** Records every storage and cookie write, and every URL or history change, from the start of the document. */
async function watchWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __writes: string[] };
    w.__writes = [];
    for (const name of ["setItem", "removeItem", "clear"] as const) {
      const original = Storage.prototype[name] as (...args: unknown[]) => unknown;
      Storage.prototype[name] = function (this: Storage, ...args: unknown[]) {
        w.__writes.push(`storage.${name}`);
        return original.apply(this, args);
      } as never;
    }
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (cookie?.set && cookie.get) {
      const setCookie = cookie.set;
      Object.defineProperty(Document.prototype, "cookie", {
        configurable: true,
        get: cookie.get,
        set(this: Document, value: string) {
          w.__writes.push("cookie");
          setCookie.call(this, value);
        },
      });
    }
    for (const name of ["pushState", "replaceState"] as const) {
      const original = History.prototype[name];
      History.prototype[name] = function (this: History, ...args: Parameters<History["pushState"]>) {
        w.__writes.push(`history.${name}`);
        return original.apply(this, args);
      };
    }
    addEventListener("hashchange", () => w.__writes.push("hashchange"));
  });
}
const writes = (page: Page) => page.evaluate(() => (window as unknown as { __writes: string[] }).__writes);

/** Changes a setting of every kind. */
async function changeEverything(page: Page): Promise<void> {
  await chooseStyle(page, "purple");
  await chooseTheme(page, "dark");
  await setRange(page.locator("#pw-length"), 32);
  await page.locator("#pw-numbers").uncheck();
  await page.locator("#pw-complex").uncheck();
  await page.locator("#pw-lookalikes").check();
  await page.locator("#pw-no-start-symbol").uncheck();
  await setNumber(page.locator("#pw-lowercase-min"), 3);
  await setNumber(page.locator("#pw-uppercase-max"), 5);
  await setNumber(page.locator("#pw-symbols-min"), 2);
  await page.locator("#pp-word-list").selectOption("eff-large");
  await setRange(page.locator("#pp-words"), 7);
  await setNumber(page.locator("#pp-min-length"), 4);
  await setNumber(page.locator("#pp-max-length"), 6);
  await page.locator("#pp-number-digits").selectOption("3");
  await page.locator("#pp-symbol-char").selectOption("#");
  await page.locator("#pp-symbol-position").selectOption("after");
  await page.locator("#pp-lookalikes").check();
  await page.locator("#pp-capitalize").selectOption("every");
}

/** Opens a page in a new, empty context and returns the code for `change`d settings there. */
async function codeFrom(browser: Browser, change: (page: Page) => Promise<void>) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openPage(page);
  await change(page);
  await get(page).click();
  await expect(status(page)).toHaveText(CODE_READY_STATUS);
  const code = (await shown(page).textContent()) ?? "";
  const source = await state(page);
  await context.close();
  return { code, source };
}

test.describe("settings code", () => {
  test("a code applied in a fresh context reproduces every setting and the strength shown, and writes nothing anywhere", async ({
    browser,
    page,
    watched,
  }) => {
    const { code, source } = await codeFrom(browser, changeEverything);
    expect(code).toMatch(/^PG1(-[0-9A-HJKMNP-TV-Z]{1,4})+$/);

    await watchWrites(page);
    await openPage(page);
    const url = page.url();
    const historyLength = await page.evaluate(() => window.history.length);
    const before = await state(page);
    expect(before).not.toEqual(source);
    await input(page).fill(code.toLowerCase());
    await apply(page).click();
    await expect(status(page)).toHaveText(CODE_APPLIED_STATUS);
    await expect(input(page)).not.toHaveAttribute("aria-invalid");
    expect(await state(page)).toEqual(source);
    await expect(page.locator("#pw-value")).not.toHaveText("");
    await expect(page.locator("#pp-value")).not.toHaveText("");

    // The same settings give the same code here.
    await get(page).click();
    await expect(shown(page)).toHaveText(code);

    await page.waitForLoadState("networkidle");
    expect(await writes(page)).toEqual([]);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([
      0,
      0,
      "",
    ]);
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
    await expectNoRequestsAfterLoad(page, watched);
    expect(watched.problems).toEqual([]);
    expect(await watched.violations()).toEqual([]);
  });

  test("applying does not save: a reload opens with the defaults, and Save keeps the applied settings", async ({
    browser,
    page,
  }) => {
    const { code, source } = await codeFrom(browser, changeEverything);
    await openPage(page);
    const defaults = await state(page);
    await input(page).fill(code);
    await input(page).press("Enter");
    await expect(status(page)).toHaveText(CODE_APPLIED_STATUS);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    expect(await state(page)).toEqual(defaults);
    await input(page).fill(code);
    await apply(page).click();
    await page.locator("#save-settings").click();
    await expect(page.locator("#save-settings-status")).toContainText("Saved");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    expect(await state(page)).toEqual(source);
  });

  const bad: Array<[string, () => string, string]> = [
    ["empty", () => "", CODE_ERROR_STATUS.empty],
    ["not a code", () => "correct horse battery staple", CODE_ERROR_STATUS.format],
    ["a typo", () => "PG1-ZX", CODE_ERROR_STATUS.checksum],
    ["another version", () => "PG2-ZW", CODE_ERROR_STATUS.version],
    [
      "settings this page refuses",
      () => encodeSettingsCode({ ...BASELINE, password: { ...BASELINE.password, length: 3 } }),
      CODE_ERROR_STATUS.unavailable,
    ],
  ];
  for (const [name, text, message] of bad) {
    test(`a bad code (${name}) changes nothing and says why, with the keyboard and to screen readers`, async ({
      page,
      watched,
    }) => {
      await watchWrites(page);
      await openPage(page);
      await chooseTheme(page, "light");
      await setRange(page.locator("#pw-length"), 24);
      const before = await state(page);
      const password = await page.locator("#pw-value").textContent();
      const passphrase = await page.locator("#pp-value").textContent();
      await input(page).focus();
      await page.keyboard.type(text());
      await page.keyboard.press("Enter");
      await expect(status(page)).toHaveText(message);
      await expect(status(page)).toHaveAttribute("role", "status");
      await expect(status(page)).toHaveAttribute("aria-live", "polite");
      await expect(input(page)).toHaveAttribute("aria-invalid", "true");
      await expect(input(page)).toHaveAccessibleDescription(message);
      await expect(input(page)).toBeFocused();
      expect(await state(page)).toEqual(before);
      // Not even regenerated: the results are the ones shown before.
      await expect(page.locator("#pw-value")).toHaveText(password ?? "");
      await expect(page.locator("#pp-value")).toHaveText(passphrase ?? "");
      // Typing again clears the error mark.
      await page.keyboard.type("x");
      await expect(input(page)).not.toHaveAttribute("aria-invalid");
      expect(await writes(page)).toEqual([]);
      await expectNoRequestsAfterLoad(page, watched);
      expect(watched.problems).toEqual([]);
    });
  }

  test("Get works from the keyboard, the shown code is cleared by any later change, and Copy copies it", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __copied: string[] };
      w.__copied = [];
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: async (text: string) => void w.__copied.push(text) },
      });
    });
    await openPage(page);
    await expect(copy(page)).toBeDisabled();
    await expect(shown(page)).toHaveText("");
    await get(page).focus();
    await page.keyboard.press("Enter");
    await expect(shown(page)).toHaveText("PG1-ZW");
    await expect(status(page)).toHaveText(CODE_READY_STATUS);
    await expect(copy(page)).toBeEnabled();
    await copy(page).click();
    await expect(copy(page)).toHaveText("Copied");
    expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual(["PG1-ZW"]);
    await page.locator("#pw-numbers").uncheck();
    await expect(shown(page)).toHaveText("");
    await expect(status(page)).toHaveText("");
    await expect(copy(page)).toBeDisabled();
    // Settings the generators refuse give no code.
    await setNumber(page.locator("#pw-lowercase-min"), 99);
    await get(page).click();
    await expect(status(page)).toContainText("fix the settings");
    await expect(shown(page)).toHaveText("");
  });

  test("neither the code nor any status contains a generated password or passphrase", async ({ browser, page }) => {
    const { code } = await codeFrom(browser, changeEverything);
    await openPage(page);
    await input(page).fill(code);
    await apply(page).click();
    await get(page).click();
    const texts = [
      code,
      (await shown(page).textContent()) ?? "",
      (await status(page).textContent()) ?? "",
      (await page.locator("#save-settings-status").textContent()) ?? "",
    ].map((text) => text.toUpperCase());
    const outputs = await page.locator("[data-generated]").allTextContents();
    expect(outputs.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    for (const output of outputs.filter(Boolean))
      for (const text of texts) expect(text.includes(output.toUpperCase())).toBe(false);
  });
});
