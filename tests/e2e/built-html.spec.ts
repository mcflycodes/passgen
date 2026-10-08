// Every HTML file in dist/, as the browser parses it. These checks read the
// browser's own DOM rather than a hand-written parser, so what passes here is
// what a user's browser sees. URLs, host names and attribution are judged by
// the same helpers verify-dist uses (resolveWithinDist, findHostnames, scanText).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { metaCsp } from "../../security/headers.ts";
import { attributionProblems, collectLiveDom, liveDomProblems, staticHostnameProblems } from "./dom-checks.ts";
import { expect, test } from "./fixtures.ts";
import { DIST_DIR, ORIGINS, SUBPATH } from "./servers.ts";

const HTML_FILES = readdirSync(DIST_DIR, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.split("\\").join("/"))
  .sort();

test("the build contains at least one HTML page", () => {
  expect(HTML_FILES).toContain("index.html");
});

for (const file of HTML_FILES) {
  test.describe(`dist/${file}`, () => {
    test("has no host names in its static content as the browser parses it", async ({ page }) => {
      const html = readFileSync(join(DIST_DIR, file), "utf8");
      expect(await staticHostnameProblems(page, file, html)).toEqual([]);
    });

    test("follows the markup and URL rules in the live DOM", async ({ page }) => {
      await page.goto(`${ORIGINS.subpath}${SUBPATH}${file}`);
      expect(liveDomProblems(file, await collectLiveDom(page))).toEqual([]);
    });

    test("credits no tool anywhere a reader could see, including CSS-generated text", async ({ page }) => {
      await page.goto(`${ORIGINS.subpath}${SUBPATH}${file}`);
      expect(attributionProblems(await collectLiveDom(page))).toEqual([]);
    });

    test("enforces its meta CSP on a host that sets no headers", async ({ page, watched }) => {
      const pageUrl = `${ORIGINS.noHeaders}/${file}`;
      const res = await page.goto(pageUrl);
      expect(res?.headers()["content-security-policy"]).toBeUndefined();

      const structure = await page.evaluate(() => {
        const metas = [...document.querySelectorAll("meta[http-equiv]")];
        const csp = metas[0];
        return {
          count: metas.length,
          inHead: csp?.parentElement === document.head,
          headOrder: [...document.head.children].slice(0, 2).map((el) => el.outerHTML),
          httpEquiv: csp?.getAttribute("http-equiv"),
          content: csp?.getAttribute("content"),
        };
      });
      expect(structure).toEqual({
        count: 1,
        inHead: true,
        headOrder: ['<meta charset="utf-8">', `<meta http-equiv="Content-Security-Policy" content="${metaCsp()}">`],
        httpEquiv: "Content-Security-Policy",
        content: metaCsp(),
      });

      const outcome = await page.evaluate(async () => {
        const fetched = await fetch("./").then(
          () => "allowed",
          () => "blocked",
        );
        let eventSource = "blocked";
        try {
          const es = new EventSource("./events");
          eventSource = await new Promise<string>((resolve) => {
            es.onopen = () => resolve("allowed");
            es.onerror = () => resolve("blocked");
            setTimeout(() => resolve("blocked"), 1000);
          });
          es.close();
        } catch {
          // Some engines throw synchronously on a CSP block.
        }
        await new Promise((r) => setTimeout(r, 50));
        return { fetched, eventSource };
      });
      expect(outcome).toEqual({ fetched: "blocked", eventSource: "blocked" });
      const violations = await watched.violations();
      expect(violations).toContain(`connect-src ${new URL("./", pageUrl).href}`);
      expect(violations).toContain(`connect-src ${new URL("./events", pageUrl).href}`);
    });
  });
}
