import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { build } from "vite";
import { renderPage } from "../../scripts/lib/page-template.ts";
import { config, wordListCredits } from "../../src/config/validate.ts";
import { passphraseEntropy } from "../../src/core/entropy.ts";
import { defaultPassphraseOptions, switchWordList } from "../../src/core/passphrase.ts";
import { WORD_LISTS, type WordListId, wordListDescription } from "../../src/core/wordlists.ts";
import { expect, test } from "./fixtures.ts";
import { chooseStyle, chooseTheme, openPage, STYLES, setNumber } from "./helpers.ts";

const root = join(import.meta.dirname, "../..");

test("word list dropdown describes each list, clamps lengths and recalculates strength", async ({ page }) => {
  await openPage(page);
  const select = page.getByLabel("Word list", { exact: true });
  await expect(select).toHaveValue("orchard-long");
  await expect(select.locator("option")).toHaveCount(5);
  for (const wordList of Object.keys(WORD_LISTS) as WordListId[]) {
    await select.selectOption("orchard-long");
    await setNumber(page.locator("#pp-max-length"), 15);
    await setNumber(page.locator("#pp-min-length"), 10);
    await select.selectOption(wordList);
    const options = switchWordList({ ...defaultPassphraseOptions, minWordLength: 10, maxWordLength: 15 }, wordList);
    await expect(page.locator("#pp-word-list-description")).toHaveText(wordListDescription(wordList));
    for (const id of ["pp-min-length", "pp-max-length"]) {
      await expect(page.locator(`#${id}`)).toHaveAttribute("min", String(WORD_LISTS[wordList].min));
      await expect(page.locator(`#${id}`)).toHaveAttribute("max", String(WORD_LISTS[wordList].max));
    }
    await expect(page.locator("#pp-min-length")).toHaveValue(String(options.minWordLength));
    await expect(page.locator("#pp-max-length")).toHaveValue(String(options.maxWordLength));
    await expect(page.locator("#pp-bits")).toContainText(
      `${(Math.floor(passphraseEntropy(options).bits * 10) / 10).toFixed(1)} bits`,
    );
  }
});

test("save and reset include the selected word list", async ({ page }) => {
  await openPage(page);
  await page.locator("#pp-word-list").selectOption("eff-short1");
  await page.locator("#save-settings").click();
  await page.reload();
  await expect(page.locator("#pp-word-list")).toHaveValue("eff-short1");
  await expect(page.locator("#pp-max-length")).toHaveValue("5");
  await page.locator("#reset-settings").click();
  await expect(page.locator("#pp-word-list")).toHaveValue("orchard-long");
  await expect(page.locator("#pp-max-length")).toHaveValue("10");
});

test("Credits start collapsed, toggle by keyboard and preserve everything above", async ({ page }) => {
  await openPage(page);
  const details = page.locator("#wordlist-credits");
  const summary = details.locator("summary");
  await expect(details).not.toHaveAttribute("open", "");
  await expect(details.locator("li").first()).toBeHidden();
  await page.locator("#license-link").focus();
  await page.keyboard.press("Tab");
  await expect(summary).toBeFocused();
  const above = () =>
    page.locator("main, .foot-text, .foot-version, #wordlist-credits summary").evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y + scrollY, width: r.width };
      }),
    );
  const before = await above();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  expect(await above()).toEqual(before);
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
    await expect(entry.getByRole("link", { name: "Source", exact: true })).toHaveAttribute("href", credit.source.url);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Space");
  await expect(details).not.toHaveAttribute("open", "");
});

test("single offered list hides dropdown and credits only that list", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "passgen-one-list-"));
  try {
    for (const entry of ["index.html", "src", "public", "vendor"])
      await cp(join(root, entry), join(dir, entry), { recursive: true });
    const copy = structuredClone(config);
    const offered = copy.passphrase.wordLists.offered.find((entry) => entry.id === "eff-short1");
    if (!offered) throw new Error("Missing list fixture");
    copy.passphrase.wordLists = { default: offered.id, offered: [offered] };
    await writeFile(join(dir, "src/config/config.json"), JSON.stringify(copy));
    // Exercise the same template and production bundler as a one-list deployment.
    const index = await readFile(join(dir, "index.html"), "utf8");
    expect(renderPage(index, copy, { version: "1.3.0" })).not.toContain('id="pp-word-list"');
    await build({ root: dir, configFile: join(root, "vite.config.ts"), logLevel: "silent" });
    await page.route("**/*", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = join(dir, "dist", path === "/" ? "index.html" : path);
      const contentType = path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".svg")
            ? "image/svg+xml"
            : "text/html";
      await route.fulfill({ status: 200, contentType, body: await readFile(file) });
    });
    await openPage(page);
    await expect(page.locator("#pp-word-list")).toHaveCount(0);
    await expect(page.locator("#pp-word-list-description")).toHaveText(wordListDescription("eff-short1"));
    await expect(page.locator("#pp-min-length")).toHaveValue("3");
    await expect(page.locator("#pp-max-length")).toHaveAttribute("max", "5");
    await page.locator("#wordlist-credits summary").click();
    await expect(page.locator("#wordlist-credits li")).toHaveCount(1);
    await expect(page.locator("#wordlist-credits li")).toContainText("EFF Short #1");
    await expect(page.locator("#wordlist-credits li")).toContainText("Joseph Bonneau et al.");
    await expect(page.locator("#wordlist-credits li")).toContainText("CC BY 4.0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const style of STYLES)
  for (const theme of ["light", "dark"] as const)
    test(`expanded Credits accessible in ${style}/${theme} @a11y-matrix`, async ({ page }) => {
      await openPage(page);
      await chooseStyle(page, style);
      await chooseTheme(page, theme);
      await page.locator("#wordlist-credits summary").click();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations).toEqual([]);
    });
