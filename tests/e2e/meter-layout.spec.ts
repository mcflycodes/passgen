import type { Page } from "@playwright/test";
import { WORD_LISTS } from "../../src/core/wordlists.ts";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, chooseTheme, openPage, STYLES, setNumber, setRange } from "./helpers.ts";

async function position(page: Page, prefix: "pw" | "pp") {
  return page.evaluate((prefix) => {
    const rect = (id: string) => {
      const element = document.getElementById(id);
      if (!element) throw new Error(`Missing ${id}`);
      return element.getBoundingClientRect();
    };
    const meter = rect(`${prefix}-meter`);
    const ids = prefix === "pw" ? ["pw-length", "pw-lowercase-min"] : ["pp-words", "pp-min-length"];
    return {
      height: meter.height,
      absolute: ids.map((id) => rect(id).top + scrollY),
      relative: ids.map((id) => rect(id).top - meter.bottom),
    };
  }, prefix);
}

// DOMRect arithmetic can vary below a pixel as Firefox changes scroll position.
// Keep the same half-pixel limit for heights, page positions and relative offsets.
function expectStablePosition(actual: number | number[], expected: number | number[], label: string) {
  const received = typeof actual === "number" ? [actual] : actual;
  const baseline = typeof expected === "number" ? [expected] : expected;
  expect(received, `${label}: measurement count`).toHaveLength(baseline.length);
  for (const [index, value] of received.entries()) {
    const original = baseline[index];
    if (original === undefined) throw new Error(`${label}: missing baseline measurement ${index}`);
    expect(Math.abs(value - original), `${label}[${index}]: movement in pixels`).toBeLessThanOrEqual(0.5);
  }
}

for (const style of STYLES) {
  for (const theme of style === "calm" ? (["light", "dark"] as const) : (["light"] as const)) {
    for (const prefix of ["pw", "pp"] as const) {
      test(`${style}/${theme} ${prefix} meter keeps controls stationary`, async ({ page }) => {
        test.setTimeout(180_000);
        await openPage(page);
        await chooseStyle(page, style);
        await chooseTheme(page, theme);
        // Fixed word lengths remove random output-length variation, while still
        // exercising real generation and every strength band via pool/word settings.
        if (prefix === "pp") {
          await setNumber(page.locator("#pp-min-length"), 5);
          await setNumber(page.locator("#pp-max-length"), 5);
        }
        for (const expanded of [false, true]) {
          if (expanded) await page.locator(`#${prefix}-meter summary`).click();
          // Keep the original EFF pool for the six-band and longest-warning coverage.
          if (prefix === "pp") await page.locator("#pp-word-list").selectOption("eff-large");
          const initial = await position(page, prefix);
          const bands = new Set<string>();
          const check = async (label: string, absolute?: number[]) => {
            const current = await position(page, prefix);
            expectStablePosition(current.height, initial.height, `${label}: meter height`);
            expectStablePosition(current.relative, initial.relative, `${label}: offsets from meter bottom`);
            if (absolute) expectStablePosition(current.absolute, absolute, `${label}: page positions`);
            bands.add((await page.locator(`#${prefix}-band`).textContent()) ?? "");
          };
          if (prefix === "pw") {
            await setRange(page.locator("#pw-length"), 4);
            const reserved = await position(page, prefix);
            for (let length = 4; length <= 128; length++) {
              await setRange(page.locator("#pw-length"), length);
              await check(`length ${length}`, length <= 40 ? reserved.absolute : undefined);
            }
            // At both sides of the NTLM threshold and the longest output, counts
            // and character options change entropy without changing value length.
            for (const length of [18, 20, 128]) {
              await setRange(page.locator("#pw-length"), length);
              const fixed = await position(page, prefix);
              for (const type of ["lowercase", "uppercase", "numbers", "symbols"]) {
                for (const field of ["min", "max"]) {
                  const id = `#pw-${type}-${field}`;
                  const original = Number(await page.locator(id).inputValue());
                  await setNumber(page.locator(id), field === "min" ? original + 1 : length - 1);
                  await check(`${length}/${type}/${field}`, fixed.absolute);
                  await setNumber(page.locator(id), original);
                  await check(`${length}/${type}/${field} restored`, fixed.absolute);
                }
              }
              for (const id of [
                "pw-lookalikes",
                "pw-no-start-symbol",
                "pw-complex",
                "pw-uppercase",
                "pw-numbers",
                "pw-simple",
              ]) {
                await page.locator(`#${id}`).evaluate((el) => (el as HTMLInputElement).click());
                await check(`${length}/${id}`, fixed.absolute);
                await page.locator(`#${id}`).evaluate((el) => (el as HTMLInputElement).click());
                await check(`${length}/${id} restored`, fixed.absolute);
              }
              // Only symbols shows the skipped first-character-rule notice.
              for (const id of ["pw-lowercase", "pw-uppercase", "pw-numbers"]) {
                await page.locator(`#${id}`).uncheck();
                await check(`${length}/${id} removed`, fixed.absolute);
              }
              await expect(page.locator("#pw-notice")).toBeVisible();
              for (const id of ["pw-lowercase", "pw-uppercase", "pw-numbers"]) {
                await page.locator(`#${id}`).check();
                await check(`${length}/${id} restored`, fixed.absolute);
              }
            }
          } else {
            await setRange(page.locator("#pp-words"), 2);
            const reserved = await position(page, prefix);
            for (let words = 2; words <= 12; words++) {
              await setRange(page.locator("#pp-words"), words);
              await check(`words ${words}`, words <= 5 ? reserved.absolute : undefined);
            }
            for (const words of [2, 5, 12]) {
              await setRange(page.locator("#pp-words"), words);
              const fixed = await position(page, prefix);
              for (const id of ["pp-lookalikes", "pp-number", "pp-symbol"]) {
                await page.locator(`#${id}`).evaluate((el) => (el as HTMLInputElement).click());
                await check(`${words}/${id}`, words <= 5 ? fixed.absolute : undefined);
                await page.locator(`#${id}`).evaluate((el) => (el as HTMLInputElement).click());
                await check(`${words}/${id} restored`, fixed.absolute);
              }
              for (const capitalize of ["random", "every", "off"]) {
                await page.locator("#pp-capitalize").selectOption(capitalize);
                await check(`${words}/${capitalize}`, fixed.absolute);
              }
              for (const symbol of ["-", "random", "random-unique", "random"]) {
                await page.locator("#pp-symbol-char").selectOption(symbol);
                await check(`${words}/${symbol}`, fixed.absolute);
              }
              for (const field of ["min", "max"]) {
                await setNumber(page.locator(`#pp-${field}-length`), field === "min" ? 4 : 6);
                await check(`${words}/${field} length`, words <= 5 ? fixed.absolute : undefined);
                await setNumber(page.locator(`#pp-${field}-length`), 5);
                await check(`${words}/${field} restored`, fixed.absolute);
              }
            }
            await page.locator("#pp-word-list").selectOption("orchard-long");
            await setRange(page.locator("#pp-words"), 5);
            await setNumber(page.locator("#pp-max-length"), 10);
            await check("default word range / Very strong");
            // The longest default words exercise the whole default-range output
            // reservation, independently of the shorter fixed pool above.
            await setNumber(page.locator("#pp-min-length"), 10);
            await setNumber(page.locator("#pp-max-length"), 10);
            await setRange(page.locator("#pp-words"), 2);
            const defaultRange = await position(page, prefix);
            for (let words = 2; words <= 5; words++) {
              await setRange(page.locator("#pp-words"), words);
              await check(`long default words/${words}`, defaultRange.absolute);
            }
            // Small pools reach Very weak and exercise the longest warning text.
            await page.locator("#pp-word-list").selectOption("eff-large");
            await page.locator("#pp-number").uncheck();
            await page.locator("#pp-symbol").uncheck();
            await setNumber(page.locator("#pp-min-length"), 3);
            await setNumber(page.locator("#pp-max-length"), 3);
            for (let words = 2; words <= 12; words++) {
              await setRange(page.locator("#pp-words"), words);
              await check(`narrow pool/${words}`);
            }
            await expect(page.locator("#pp-meter-warning")).toBeVisible();
            await page.locator("#pp-number").check();
            await page.locator("#pp-symbol").check();
            await setNumber(page.locator("#pp-min-length"), 5);
            await setNumber(page.locator("#pp-max-length"), 5);
          }
          expect([...bands]).toEqual(
            expect.arrayContaining(["Very weak", "Weak", "Moderate", "Strong", "Very strong", "Excellent"]),
          );
          if (!expanded) continue;
          await expect(page.locator(`#${prefix}-scenarios`)).toContainText("NTLM search capped at its 128-bit digest.");
          expect(await page.locator(`#${prefix}-scenarios`).ariaSnapshot()).toContain("128-bit digest");
          await expect(page.locator(`#${prefix}-meter-status`)).toContainText(
            "NTLM search capped at its 128-bit digest.",
          );
        }
      });
    }
  }
}

for (const width of [320, 900, 2400]) {
  test(`meter and default output reservations at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openPage(page);
    for (const prefix of ["pw", "pp"] as const) {
      const initial = await position(page, prefix);
      const range = page.locator(prefix === "pw" ? "#pw-length" : "#pp-words");
      for (const value of prefix === "pw" ? [4, 18, 20, 128] : [2, 5, 12]) {
        await setRange(range, value);
        const current = await position(page, prefix);
        expectStablePosition(current.height, initial.height, `${prefix}/${value}: meter height`);
        expectStablePosition(current.relative, initial.relative, `${prefix}/${value}: offsets from meter bottom`);
        if (value <= (prefix === "pw" ? 20 : 5))
          expectStablePosition(current.absolute, initial.absolute, `${prefix}/${value}: page positions`);
      }
    }
  });
}

test("enabled future estimates reserve their changing text", async ({ page }) => {
  let replaced = false;
  await page.route("**/assets/index-*.js", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = "enabled:!1,iterationSeconds:15,processors:1";
    replaced = body.includes(marker);
    await route.fulfill({ response, body: body.replace(marker, "enabled:!0,iterationSeconds:15,processors:1") });
  });
  await openPage(page);
  expect(replaced).toBe(true);
  for (const prefix of ["pw", "pp"] as const) {
    await expect(page.locator(`#${prefix}-future`)).toBeVisible();
    const initial = await position(page, prefix);
    for (const value of prefix === "pw" ? [4, 18, 20, 128] : [2, 5, 12]) {
      await setRange(page.locator(prefix === "pw" ? "#pw-length" : "#pp-words"), value);
      const current = await position(page, prefix);
      expectStablePosition(current.height, initial.height, `${prefix}/${value}: meter height`);
      expectStablePosition(current.relative, initial.relative, `${prefix}/${value}: offsets from meter bottom`);
    }
  }
});

for (const width of [320, 900, 901, 2400]) {
  for (const style of STYLES)
    test(`${style} list switching preserves meter and result reservations at ${width}px`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width, height: 1000 });
      await openPage(page);
      await page.locator("#pp-number-digits").selectOption("3");
      await chooseStyle(page, style);
      for (const expanded of [false, true]) {
        const meter = page.locator("#pp-meter details");
        if (((await meter.getAttribute("open")) !== null) !== expanded) await meter.locator("summary").click();
        await setRange(page.locator("#pp-words"), 2);
        const baseline = await position(page, "pp");
        for (const [id, list] of Object.entries(WORD_LISTS)) {
          await page.locator("#pp-word-list").selectOption(id);
          await setNumber(page.locator("#pp-max-length"), list.max);
          await setNumber(page.locator("#pp-min-length"), list.max);
          for (const words of [2, 3, 4, 5]) {
            await setRange(page.locator("#pp-words"), words);
            const current = await position(page, "pp");
            const label = `${style}/${expanded}/${id}/${words}`;
            expectStablePosition(current.height, baseline.height, `${label}: meter height`);
            expectStablePosition(current.relative, baseline.relative, `${label}: offsets from meter bottom`);
            expectStablePosition(current.absolute, baseline.absolute, `${label}: page positions`);
          }
          if (id === "orchard-long")
            await expect(page.locator("#pp-value")).toHaveText(/^[a-z]{15}(?:[^a-z]\d{3}[^a-z][a-z]{15}){4}$/);
        }
        await page.locator("#pp-word-list").selectOption("orchard-long");
        await setNumber(page.locator("#pp-min-length"), 5);
        await setNumber(page.locator("#pp-max-length"), 9);
        await setRange(page.locator("#pp-words"), 2);
        await page.locator("#pp-number").uncheck();
        await page.locator("#pp-symbol").uncheck();
        await expect(page.locator("#pp-meter-warning")).toContainText("12,148 words");
        const warning = await position(page, "pp");
        expectStablePosition(warning.height, baseline.height, `${style}: five-digit pool warning height`);
        expectStablePosition(warning.absolute, baseline.absolute, `${style}: five-digit pool warning position`);
        await page.locator("#pp-number").check();
        await page.locator("#pp-symbol").check();
      }
    });
}
