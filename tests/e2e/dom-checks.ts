// Browser-side checks on built pages, shared by built-html.spec.ts and the
// gate regressions. The browser does the parsing; the judging uses the same
// helpers as verify-dist (resolveWithinDist, findHostnames, scanText).
//
// Generated values: elements the app fills with generated passwords or
// passphrases carry the `data-generated` attribute. Random output can look like
// a host name (`9Qa.com#rX5?`), so the host-name scan skips those elements.
// Attribution exempts explicit collision words only in complete possible passphrases
// inside marked output. Attributes, comments and CSS text remain under the scan.

import type { Page } from "@playwright/test";
import { scanText, stripInvisible } from "../../scripts/lib/attribution-scan.ts";
import { findHostnames, resolveWithinDist } from "../../scripts/lib/dist-checks.ts";
import { generatedPassphraseInput, isGeneratedPassphrase } from "./generated-passphrase.ts";

export const GENERATED_ATTRIBUTE = "data-generated";

/** A percentage from 0% to 100% exactly, at most two decimals. */
const PERCENT = String.raw`^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)%$`;
/** A number from 0 to 1 exactly, at most four decimals. */
const UNIT = String.raw`^(?:1(?:\.0{1,4})?|0(?:\.\d{1,4})?)$`;

/**
 * The only inline style the live page may carry, set through the CSSOM by
 * the app, never present in the shipped HTML: the pointer effect's custom
 * properties on <html> (src/ui/pointer.ts) and the slider fill on range
 * inputs (src/ui/dom.ts). Each property is named, its value bounded, and
 * nothing may be !important. Everything else with a style attribute fails.
 */
export const INLINE_STYLE_ALLOWED: ReadonlyArray<{
  /** The elements the rule covers, as a selector. */
  readonly selector: string;
  /** Each allowed property with the pattern its value must match, as a regular expression source. */
  readonly properties: Readonly<Record<string, string>>;
}> = [
  {
    selector: "html",
    properties: {
      "--px": PERCENT,
      "--py": PERCENT,
      "--pxs": PERCENT,
      "--pys": PERCENT,
      "--pxt": PERCENT,
      "--pyt": PERCENT,
      "--pxn": UNIT,
      "--pyn": UNIT,
    },
  },
  {
    selector: 'input[type="range"]',
    properties: { "--fill": PERCENT },
  },
];

/** Attributes whose value the browser may fetch or navigate to. */
export const URL_ATTRIBUTES = [
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "icon",
  "longdesc",
  "manifest",
  "ping",
  "poster",
  "src",
  "xlink:href",
];

/** Elements the page never needs and that can load, embed or hide content. */
export const FORBIDDEN_ELEMENTS = ["base", "embed", "frame", "iframe", "object", "style", "template", "portal"];

/**
 * Problems in the page's static content: the shipped HTML parsed by the
 * browser's DOMParser (no scripts run), with character references decoded.
 * Host names are judged in every text node, comment and attribute value
 * outside [data-generated]; a style attribute anywhere in the shipped HTML
 * is refused outright (the live page may only carry the CSSOM-set
 * properties in INLINE_STYLE_ALLOWED). Needs a page without the app's CSP
 * (Trusted Types blocks DOMParser there), so it parses on about:blank.
 */
export async function staticHostnameProblems(page: Page, file: string, html: string): Promise<string[]> {
  await page.goto("about:blank");
  const { texts, styled } = await page.evaluate(
    ({ source, generated }) => {
      const doc = new DOMParser().parseFromString(source, "text/html");
      const out: string[] = [];
      const styled: string[] = [];
      const skip = (node: Node | null) =>
        (node instanceof Element ? node : node?.parentElement)?.closest(`[${generated}]`);
      const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (!skip(node)) out.push(node.nodeValue ?? "");
      for (const el of doc.querySelectorAll("*")) {
        if (el.hasAttribute("style")) styled.push(el.localName);
        if (skip(el)) continue;
        for (const attr of el.attributes) out.push(attr.value);
      }
      return { texts: out, styled };
    },
    { source: html, generated: GENERATED_ATTRIBUTE },
  );
  return [
    ...styled.map((name) => `static content: style attribute on <${name}>`),
    ...texts.flatMap((text) => findHostnames(file, text).map((f) => `static content: ${f.problem}`)),
  ];
}

interface LiveDom {
  problems: string[];
  urlAttributes: Array<{ element: string; name: string; value: string }>;
  /** What a reader can see or hear: rendered text, title, generated content, every attribute value. */
  readable: string[];
  generatedTexts: string[];
  untouchedInnerText: string;
  innerText: string;
  textContent: string;
  baseIsPage: boolean;
}

/** Collects the live DOM after the page's scripts have run. */
export async function collectLiveDom(page: Page): Promise<LiveDom> {
  const dom = await page.evaluate(
    ({ forbidden, urlAttributes, generated, inlineAllowed }) => {
      const problems: string[] = [];
      const urls: Array<{ element: string; name: string; value: string }> = [];
      const readable: string[] = [document.title];
      const generatedTexts = [...document.querySelectorAll(`[${generated}]`)].map((el) => el.textContent ?? "");
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) readable.push(node.nodeValue ?? "");
      for (const el of document.querySelectorAll("*")) {
        const name = el.localName;
        if (forbidden.includes(name)) problems.push(`<${name}> element`);
        if (name === "script" && (!el.hasAttribute("src") || (el.textContent ?? "").trim() !== "")) {
          problems.push("inline <script>");
        }
        if (
          name === "meta" &&
          el.hasAttribute("http-equiv") &&
          el.getAttribute("http-equiv") !== "Content-Security-Policy"
        ) {
          problems.push(`<meta http-equiv="${el.getAttribute("http-equiv")}">`);
        }
        for (const attr of el.attributes) {
          if (attr.name === "style") {
            const allowed = inlineAllowed.find((rule) => el.matches(rule.selector));
            const style = (el as HTMLElement).style;
            const names = [...style];
            if (!allowed) problems.push(`style attribute on <${name}>`);
            else if (names.length === 0) problems.push(`style attribute on <${name}> with no readable property`);
            for (const property of names) {
              const pattern = allowed?.properties[property];
              if (!pattern) {
                problems.push(`style attribute on <${name}> sets ${property}`);
                continue;
              }
              const value = style.getPropertyValue(property).trim();
              if (!new RegExp(pattern).test(value))
                problems.push(`style attribute on <${name}>: ${property} is ${value}`);
              if (style.getPropertyPriority(property) !== "")
                problems.push(`style attribute on <${name}>: ${property} is !important`);
            }
          }
          if (attr.name.startsWith("on")) problems.push(`${attr.name} handler on <${name}>`);
          if (attr.name === "srcset" || attr.name === "imagesrcset") problems.push(`${attr.name} on <${name}>`);
          if (urlAttributes.includes(attr.name)) urls.push({ element: name, name: attr.name, value: attr.value });
          readable.push(attr.value);
        }
        // Text that CSS generates is not in innerText.
        for (const pseudo of ["::before", "::after", "::marker"]) {
          const content = getComputedStyle(el, pseudo).content;
          if (content && content !== "none" && content !== "normal") readable.push(content);
        }
      }
      return {
        problems,
        urlAttributes: urls,
        readable,
        generatedTexts,
        baseIsPage: document.baseURI === location.href,
      };
    },
    {
      forbidden: FORBIDDEN_ELEMENTS,
      urlAttributes: URL_ATTRIBUTES,
      generated: GENERATED_ATTRIBUTE,
      inlineAllowed: INLINE_STYLE_ALLOWED,
    },
  );
  const validated = dom.generatedTexts.flatMap((text, index) => (isGeneratedPassphrase(text) ? [index] : []));
  const rendered = await page.evaluate(
    ({ generated, texts, indexes }) => {
      const untouchedInnerText = document.body.innerText;
      const outputs = [...document.querySelectorAll(`[${generated}]`)];
      const restore: Array<{ node: Text; value: string }> = [];
      try {
        for (const index of indexes) {
          const output = outputs[index];
          // Recheck the snapshot: an asynchronous regeneration must fail closed.
          if (!output || output.textContent !== texts[index]) continue;
          const walker = document.createTreeWalker(output, NodeFilter.SHOW_TEXT);
          let first = true;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node as Text;
            restore.push({ node: text, value: text.data });
            text.data = first ? "0" : "";
            first = false;
          }
        }
        return { untouchedInnerText, innerText: document.body.innerText, textContent: document.body.textContent ?? "" };
      } finally {
        for (const { node, value } of restore) node.data = value;
      }
    },
    { generated: GENERATED_ATTRIBUTE, texts: dom.generatedTexts, indexes: validated },
  );
  return { ...dom, ...rendered };
}

/** Markup, URL and host-name problems in URL-bearing attributes of the live DOM. */
export function liveDomProblems(file: string, dom: LiveDom): string[] {
  const problems = [...dom.problems];
  if (!dom.baseIsPage) problems.push("document base URL differs from the page URL");
  for (const { element, name, value } of dom.urlAttributes) {
    if (resolveWithinDist(file, value) === null) problems.push(`${name}="${value}" on <${element}> leaves the build`);
    for (const f of findHostnames(file, value)) problems.push(`${name} on <${element}>: ${f.problem}`);
  }
  return problems;
}

/** Retain rendered adjacency, and scan every output independently with the narrow exception. */
export function attributionProblems(dom: LiveDom): string[] {
  const outputs = dom.generatedTexts.map(generatedPassphraseInput);
  // Keep credits spanning output boundaries without reporting bare dictionary collisions.
  const credits = scanText("untouched rendered text", stripInvisible(dom.untouchedInnerText)).filter((finding) =>
    ["authorship credit", "credit to a tool", "co-author trailer naming a tool"].some((label) =>
      finding.includes(`: ${label}: `),
    ),
  );
  return [
    ...credits,
    ...[dom.innerText, dom.textContent, ...outputs, ...dom.readable].flatMap((text, i) =>
      scanText(`readable text ${i}`, stripInvisible(text)),
    ),
  ];
}
