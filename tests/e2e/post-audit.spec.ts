import { AxeBuilder } from "@axe-core/playwright";
import { config } from "../../src/config/validate.ts";
import { passphraseBits } from "../../src/core/entropy.ts";
import { bcryptPassphrasePrefixBits } from "../../src/core/hash-entropy.ts";
import { defaultPassphraseOptions } from "../../src/core/passphrase.ts";
import { crackTime } from "../../src/ui/meter.ts";
import { expect, test } from "./fixtures.ts";
import { openPage, setNumber } from "./helpers.ts";

test("all generated values are excluded from page translation and live announcements", async ({ page }) => {
  await openPage(page);
  for (const prefix of ["pw", "pp"]) await page.locator(`#${prefix}-regen`).click();
  const values = page.locator("[data-generated]");
  await expect(values).toHaveCount(2 * (config.extraResults + 1));
  for (const value of await values.all()) {
    expect(await value.evaluate((element) => (element as HTMLElement).translate)).toBe(false);
    expect(await value.evaluate((element) => element.closest('[translate="no"]') !== null)).toBe(true);
    await expect(value).toHaveAttribute("aria-live", "off");
    await expect(value).toHaveRole("group");
    await expect(value).toHaveAccessibleName((await value.getAttribute("aria-label")) ?? "");
    const tree = await value.ariaSnapshot();
    expect(tree).toMatch(/^- group "Generated (password|passphrase)/);
    expect(tree).not.toMatch(/^- (status|alert|log)\b/m);
    expect(
      await value.evaluate((element) =>
        element.parentElement?.closest(
          '[aria-live="polite"], [aria-live="assertive"], [role="status"], [role="alert"], [role="log"]',
        ),
      ),
    ).toBeNull();
  }
});

for (const [prefix, kind] of [
  ["pw", "password"],
  ["pp", "passphrase"],
])
  test(`${kind} regeneration announces status once after a burst, without values`, async ({ page }) => {
    await openPage(page);
    await expect(page.locator(`#${prefix}-meter-status`)).toContainText(`New ${kind} generated`);
    await page.evaluate((prefix) => {
      const status = document.getElementById(`${prefix}-meter-status`);
      if (!status) throw new Error("Missing status region");
      const messages: string[] = [];
      Object.assign(window, { auditMessages: messages });
      new MutationObserver(() => {
        if (status.textContent) messages.push(status.textContent);
      }).observe(status, { childList: true });
      for (let count = 0; count < 3; count++) document.getElementById(`${prefix}-regen`)?.click();
    }, prefix);
    await expect(page.locator(`#${prefix}-meter-status`)).toContainText(`New ${kind} generated`);
    const messages = await page.evaluate(() => (window as unknown as { auditMessages: string[] }).auditMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain(await page.locator(`#${prefix}-value`).innerText());
  });

test("hash caps affect offline time only, with accurate notices", async ({ page }) => {
  await openPage(page);
  for (const name of ["uppercase", "numbers", "simple"]) await page.locator(`#pw-${name}`).uncheck();
  await setNumber(page.locator("#pw-length-number"), 128);
  await expect(page.locator("#pw-headline")).toContainText(crackTime(128, config.meter.attacks.fast.guessesPerSecond));
  await expect(page.locator("#pw-scenarios")).toContainText("128-bit digest");
  expect(Number.parseFloat(await page.locator("#pw-bits").innerText())).toBeGreaterThan(600);
  await page.locator("#pw-meter summary").click();
  await expect(page.locator("#pw-scenarios")).toContainText(
    crackTime(184, config.meter.attacks.bcrypt.guessesPerSecond),
  );
  await expect(page.locator("#pw-scenarios")).toContainText("bcrypt uses the first 72 bytes");
  await expect(page.locator("#pw-scenarios")).toContainText(
    crackTime(256, config.meter.attacks.argon2id.guessesPerSecond),
  );
  await setNumber(page.locator("#pw-length-number"), 72);
  await expect(page.locator("#pw-scenarios")).not.toContainText("bcrypt uses the first 72 bytes");
  await setNumber(page.locator("#pw-length-number"), 73);
  await expect(page.locator("#pw-scenarios")).toContainText("bcrypt uses the first 72 bytes");
  await setNumber(page.locator("#pp-words-number"), 12);
  await page.locator("#pp-meter summary").click();
  await expect(page.locator("#pp-scenarios")).toContainText("bcrypt uses the first 72 bytes");
});

test("slow-hash digest limits bound the displayed estimates and disclose the caps", async ({ page }) => {
  await openPage(page);
  await setNumber(page.locator("#pw-length-number"), 128);
  await page.locator("#pw-meter summary").click();
  expect(Number.parseFloat(await page.locator("#pw-bits").innerText())).toBeGreaterThan(800);
  const bcrypt = page.locator("#pw-scenarios p").nth(0);
  const argon2id = page.locator("#pw-scenarios p").nth(1);
  await expect(bcrypt).toContainText(`${crackTime(184, config.meter.attacks.bcrypt.guessesPerSecond)} on average`);
  await expect(bcrypt).toContainText("bcrypt search capped at its 184-bit digest");
  await expect(argon2id).toContainText(`${crackTime(256, config.meter.attacks.argon2id.guessesPerSecond)} on average`);
  await expect(argon2id).toContainText("Argon2id search capped at its 256-bit digest");
  await expect(argon2id).toContainText("32-byte tag");
  for (const name of ["uppercase", "numbers", "simple"]) await page.locator(`#pw-${name}`).uncheck();
  for (const length of [39, 40, 54, 55]) {
    await setNumber(page.locator("#pw-length-number"), length);
    const bits = length * Math.log2(26);
    await expect(bcrypt).toContainText(
      `${crackTime(Math.min(bits, 184), config.meter.attacks.bcrypt.guessesPerSecond)} on average`,
    );
    await expect(argon2id).toContainText(
      `${crackTime(Math.min(bits, 256), config.meter.attacks.argon2id.guessesPerSecond)} on average`,
    );
    if (bits > 184) await expect(bcrypt).toContainText("184-bit digest");
    else await expect(bcrypt).not.toContainText("capped");
    if (bits > 256) await expect(argon2id).toContainText("256-bit digest");
    else await expect(argon2id).not.toContainText("capped");
  }
  await page.locator("#pp-meter summary").click();
  for (const words of [5, 12]) {
    await setNumber(page.locator("#pp-words-number"), words);
    const options = { ...defaultPassphraseOptions, words };
    await expect(page.locator("#pp-scenarios p").nth(0)).toContainText(
      `${crackTime(bcryptPassphrasePrefixBits(options), config.meter.attacks.bcrypt.guessesPerSecond)} on average`,
    );
    await expect(page.locator("#pp-scenarios p").nth(1)).toContainText(
      `${crackTime(Math.min(passphraseBits(options), 256), config.meter.attacks.argon2id.guessesPerSecond)} on average`,
    );
    if (passphraseBits(options) > 256)
      await expect(page.locator("#pp-scenarios")).toContainText("Argon2id search capped");
    else await expect(page.locator("#pp-scenarios")).not.toContainText(/(?:bcrypt|Argon2id) search capped/);
  }
});

test("generated value groups preserve names and associations and pass axe", async ({ page }) => {
  await openPage(page);
  for (const prefix of ["pw", "pp"]) {
    expect(
      await page.locator(`#${prefix}-value`).evaluate((output) => (output as HTMLOutputElement).htmlFor.length),
    ).toBeGreaterThan(0);
    await page.locator(`#${prefix}-regen`).click();
  }
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
  ).toEqual([]);
});
