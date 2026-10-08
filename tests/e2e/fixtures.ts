import { test as base, expect, type Page } from "@playwright/test";

export interface PageWatch {
  /** Console errors, page errors and CSP violations seen so far. */
  readonly problems: string[];
  /** Every URL the page requested. */
  readonly requests: string[];
  /** URLs requested after the main document's load event. Must stay empty. */
  readonly afterLoad: string[];
  /** Requests after the load event, with the resource type the browser reported. */
  readonly afterLoadRequests: Array<{ url: string; type: string }>;
  /**
   * The icon URL the main document declared in its shipped HTML, resolved
   * against the document URL, read from the response bytes before any script
   * could run. Empty when the document declared none.
   */
  declaredIcon(): string;
  violations(): Promise<string[]>;
}

/** Records CSP violations from the moment the document starts loading. */
async function watch(page: Page): Promise<PageWatch> {
  const problems: string[] = [];
  const requests: string[] = [];
  const afterLoad: string[] = [];
  const afterLoadRequests: Array<{ url: string; type: string }> = [];
  let declaredIcon = "";
  let loaded = false;
  // The icon the shipped page declares, taken from the main document's bytes
  // as served, so nothing the page's scripts do later can change it.
  page.on("response", async (res) => {
    const req = res.request();
    if (!req.isNavigationRequest() || req.frame() !== page.mainFrame() || res.status() !== 200) return;
    const html = await res.text().catch(() => "");
    const tag = html.match(/<link\b[^>]*\brel="icon"[^>]*>/i)?.[0] ?? "";
    const href = tag.match(/\bhref="([^"]*)"/i)?.[1];
    declaredIcon = href === undefined ? "" : new URL(href, res.url()).href;
  });
  // A new document resets tracking; same-document navigation (pushState,
  // replaceState, fragments) does not, so it cannot hide a late request.
  page.on("request", (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) loaded = false;
  });
  page.on("load", () => {
    loaded = true;
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("request", (req) => {
    requests.push(req.url());
    if (loaded) {
      afterLoad.push(req.url());
      afterLoadRequests.push({ url: req.url(), type: req.resourceType() });
    }
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  });
  return {
    problems,
    requests,
    afterLoad,
    afterLoadRequests,
    declaredIcon: () => declaredIcon,
    violations: () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations),
  };
}

export const test = base.extend<{ watched: PageWatch }>({
  watched: async ({ page }, use) => {
    await use(await watch(page));
  },
});

export { expect };

/** How long the page must stay silent after load. */
export const QUIET_PERIOD_MS = 2000;

/** Resource types a browser uses for its own favicon fetch (Chromium reports "other", Firefox "image"). */
const FAVICON_TYPES = new Set(["other", "image"]);

/**
 * Waits out the quiet period, then fails on any request made after the load
 * event. The one exception is a single browser fetch of the icon the shipped
 * HTML declared (`watched.declaredIcon()`, captured from the response bytes,
 * never from the live DOM): browsers fetch it for their own chrome, on their
 * own schedule, and some do so after the load event. A changed `href`, a
 * second fetch, or any other URL fails.
 */
export async function expectNoRequestsAfterLoad(page: Page, watched: PageWatch): Promise<void> {
  await page.waitForLoadState("load");
  await page.waitForTimeout(QUIET_PERIOD_MS);
  const icon = watched.declaredIcon();
  let faviconFetches = 0;
  const late = watched.afterLoadRequests.filter(({ url, type }) => {
    if (icon !== "" && url === icon && FAVICON_TYPES.has(type) && faviconFetches === 0) {
      faviconFetches += 1;
      return false;
    }
    return true;
  });
  expect(
    late.map((r) => r.url),
    "requests after the load event",
  ).toEqual([]);
}
