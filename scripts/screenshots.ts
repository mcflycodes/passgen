// Capture documentation images from the production build, without external requests.
// Reproduce with the pinned toolchain and Playwright Chromium on the same OS.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, devices } from "@playwright/test";
import { config, configuredLinks } from "../src/config/validate.ts";
import { attributionProblems, collectLiveDom, liveDomProblems } from "../tests/e2e/dom-checks.ts";
import { chooseStyle, chooseTheme, openPage } from "../tests/e2e/helpers.ts";
import { findHostnames } from "./lib/dist-checks.ts";
import { createStaticServer } from "./lib/static-server.ts";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "docs", "screenshots");
const shots = [
  { style: "calm", theme: "light" },
  { style: "calm", theme: "dark" },
  { style: "payload", theme: "dark" },
  { style: "slate", theme: "dark" },
  { style: "green", theme: "dark" },
  { style: "purple", theme: "dark" },
  { style: "calm", theme: "light", mobile: true },
] as const;

assert.equal(config.text.intro.enabled, true, "Documentation screenshots require the intro to be enabled");
execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
await mkdir(output, { recursive: true });
const server = createStaticServer({ root: join(root, "dist") });
let totalBytes = 0;
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  try {
    for (const shot of shots) {
      const mobile = "mobile" in shot;
      const context = await browser.newContext({
        ...(mobile
          ? { ...devices["Pixel 7"], viewport: { width: 412, height: 1100 } }
          : { viewport: { width: 1440, height: 900 } }),
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
        colorScheme: shot.theme,
        locale: "en-US",
        timezoneId: "UTC",
        serviceWorkers: "block",
      });
      try {
        const externalRequests: string[] = [];
        await context.route("**/*", async (route) => {
          if (new URL(route.request().url()).origin === origin) await route.continue();
          else {
            externalRequests.push(route.request().url());
            await route.abort();
          }
        });
        // This deterministic source exists only in the screenshot browser context.
        // Never use these documentation sample values as real passwords.
        await context.addInitScript(() => {
          let seed = 0xc0fff5;
          Object.defineProperty(crypto, "getRandomValues", {
            value: (array: Uint32Array) => {
              for (let i = 0; i < array.length; i += 1) {
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                array[i] = seed >>> 0;
              }
              return array;
            },
          });
        });
        const page = await context.newPage();
        const problems: string[] = [];
        page.on("pageerror", (error) => problems.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") problems.push(message.text());
        });
        await page.clock.setFixedTime(new Date("2026-01-01T12:00:00Z"));
        await openPage(page, `${origin}/`);
        await chooseStyle(page, shot.style);
        await chooseTheme(page, shot.theme);
        await page.locator(".intro").waitFor({ state: "visible" });
        await page.evaluate(() => document.fonts.ready);
        await page.locator("#pw-value").blur();
        await page.locator("#pp-value").blur();
        await page.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          window.scrollTo(0, 0);
        });
        const dom = await collectLiveDom(page);
        assert.deepEqual(liveDomProblems("index.html", dom, configuredLinks(config)), []);
        assert.deepEqual(attributionProblems(dom), []);
        // Scan the sample output too: none of the actual image text may look like a hostname.
        assert.deepEqual(findHostnames("screenshot", dom.untouchedInnerText), []);
        assert.deepEqual(problems, []);
        assert.deepEqual(externalRequests, []);
        const name = `${shot.style}-${shot.theme}${mobile ? "-mobile" : ""}.png`;
        const png = await page.screenshot({
          path: join(output, name),
          type: "png",
          fullPage: false,
          animations: "disabled",
          caret: "hide",
          scale: "css",
        });
        totalBytes += png.length;
        console.log(`${name}: ${png.length} bytes, SHA-256 ${createHash("sha256").update(png).digest("hex")}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
console.log(`Total: ${totalBytes} bytes (unmodified Playwright PNGs)`);
