import { AxeBuilder } from "@axe-core/playwright";
import { metaCsp, SECURITY_HEADERS } from "../../security/headers.ts";
import { expect, expectNoRequestsAfterLoad, test } from "./fixtures.ts";
import { ORIGINS, SUBPATH } from "./servers.ts";

test.describe("built page with the reference headers", () => {
  test("serves every security header on the page and its assets", async ({ page }) => {
    const responses: Array<{ url: string; headers: Record<string, string> }> = [];
    page.on("response", async (res) => {
      responses.push({ url: res.url(), headers: await res.allHeaders() });
    });
    const main = await page.goto("./");
    expect(main?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    await page.waitForLoadState("networkidle");

    expect(responses.length).toBeGreaterThanOrEqual(3);
    for (const { url, headers } of responses) {
      for (const h of SECURITY_HEADERS) {
        expect(headers[h.name.toLowerCase()], `${h.name} on ${url}`).toBe(h.value);
      }
    }
  });

  test("loads with no errors, no CSP violations and no requests to another origin", async ({ page, watched }) => {
    await page.goto("./");
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("PassGen");
    await page.waitForLoadState("networkidle");

    expect(watched.problems).toEqual([]);
    expect(await watched.violations()).toEqual([]);
    for (const url of watched.requests) expect(new URL(url).origin).toBe(ORIGINS.root);
  });

  test("makes no request at all once the page has loaded", async ({ page, watched }) => {
    await page.goto("./");
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    await expectNoRequestsAfterLoad(page, watched);
  });

  test("a changed icon link and an image fetch after load are not hidden by the icon exemption", async ({
    page,
    watched,
  }) => {
    await page.goto("./");
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    await page.waitForLoadState("load");
    expect(watched.declaredIcon()).toBe(new URL("./favicon.svg", ORIGINS.root + "/").href);
    await page.evaluate(() => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (link) link.href = "./probe-icon.svg";
      new Image().src = "./probe-image.svg";
    });
    await expect.poll(() => watched.afterLoad.some((url) => url.endsWith("/probe-image.svg"))).toBe(true);
    await expect(expectNoRequestsAfterLoad(page, watched)).rejects.toThrow(/probe-image\.svg/);
    // The exemption is the declared icon URL, not whatever the live link says now.
    expect(watched.declaredIcon()).not.toContain("probe-icon");
  });

  test("a second fetch of the declared icon by the page itself is not exempt either", async ({ page, watched }) => {
    await page.goto("./");
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    await page.waitForLoadState("load");
    await page.evaluate(() => {
      new Image().src = "./favicon.svg?1";
      new Image().src = "./favicon.svg";
    });
    await expect.poll(() => watched.afterLoad.filter((url) => url.includes("favicon.svg")).length).toBeGreaterThan(0);
    await expect(expectNoRequestsAfterLoad(page, watched)).rejects.toThrow(/favicon\.svg/);
  });

  test("still counts requests after a same-document navigation (positive control)", async ({ page, watched }) => {
    await page.goto("./");
    await page.waitForLoadState("load");
    await page.evaluate(() => {
      history.replaceState(null, "", "#details");
      new Image().src = "./late.png";
    });
    await expect.poll(() => watched.afterLoad.some((url) => url.endsWith("/late.png"))).toBe(true);
  });

  test("carries the CSP as the first tag after charset, before any script", async ({ page }) => {
    await page.goto("./");
    const head = await page.evaluate(() => [...document.head.children].map((el) => el.outerHTML));
    expect(head[0]).toBe('<meta charset="utf-8">');
    expect(head[1]).toBe(`<meta http-equiv="Content-Security-Policy" content="${metaCsp()}">`);
  });

  test("blocks network requests and inline script after load", async ({ page, watched }) => {
    await page.goto("./");
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    const result = await page.evaluate(async () => {
      const fetched = await fetch("./index.html").then(
        () => "allowed",
        () => "blocked",
      );
      try {
        const s = document.createElement("script");
        s.textContent = "window.__inlineRan = true";
        document.body.append(s);
      } catch {
        // Trusted Types refuses the assignment outright in some browsers.
      }
      await new Promise((r) => setTimeout(r, 50));
      return { fetched, inlineRan: "__inlineRan" in window };
    });
    expect(result).toEqual({ fetched: "blocked", inlineRan: false });
    expect(await watched.violations()).toContain(`connect-src ${new URL("./index.html", ORIGINS.root).href}`);
  });

  test("answers a missing path with 404 and the full header set", async ({ request }) => {
    for (const path of ["/no-such-page", "/assets/missing.js", "/.env"]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(404);
      expect(await res.text()).not.toContain("<html");
      for (const h of SECURITY_HEADERS)
        expect(res.headers()[h.name.toLowerCase()], `${h.name} on ${path}`).toBe(h.value);
    }
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`has no accessibility violations in the ${colorScheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto("./");
      await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});

test.describe("domain and host independence", () => {
  test("works unchanged under a subpath", async ({ page, watched }) => {
    await page.goto(`${ORIGINS.subpath}${SUBPATH}`);
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    await page.waitForLoadState("networkidle");
    expect(watched.problems).toEqual([]);
    expect(await watched.violations()).toEqual([]);
    for (const url of watched.requests) expect(new URL(url).pathname.startsWith(SUBPATH), url).toBe(true);
    await expectNoRequestsAfterLoad(page, watched);
  });

  test("still blocks network requests and inline script on a host that sets no headers", async ({ page, watched }) => {
    const res = await page.goto(`${ORIGINS.noHeaders}/`);
    expect(res?.headers()["content-security-policy"]).toBeUndefined();
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    const result = await page.evaluate(async () => {
      const fetched = await fetch("./index.html").then(
        () => "allowed",
        () => "blocked",
      );
      try {
        const s = document.createElement("script");
        s.textContent = "window.__inlineRan = true";
        document.body.append(s);
      } catch {
        // Trusted Types refuses the assignment outright in some browsers.
      }
      await new Promise((r) => setTimeout(r, 50));
      return { fetched, inlineRan: "__inlineRan" in window };
    });
    expect(result).toEqual({ fetched: "blocked", inlineRan: false });
    expect(await watched.violations()).toContain(`connect-src ${ORIGINS.noHeaders}/index.html`);
  });
});
