import { wordListCredits } from "../../src/config/validate.ts";
import { isWordListId, WORD_LISTS, wordListDescription } from "../../src/core/wordlists.ts";

// Fills index.html from the configuration at build time (requirements R4d
// and C1). The page text, the control defaults and the offered styles live in
// src/config/config.json, never in the markup; this module inserts them as
// escaped plain text and attribute values, so nothing is loaded or written at
// runtime and the attribution and host-name checks see the final page.
//
// The markup declares what it needs:
//
//   <!-- passgen:boot -->                        the render-blocking boot script tag (insertBootScript)
//   <!-- passgen:intro --> … <!-- /passgen:intro -->          kept only with text.intro.enabled
//   <!-- passgen:tagline --> … <!-- /passgen:tagline -->      kept only with a non-empty tagline
//   <!-- passgen:style-control --> … <!-- /passgen:style-control -->  kept only with several styles
//   <!-- passgen:style-options -->               one <option> per offered style
//   <!-- passgen:repo-link --> … <!-- /passgen:repo-link -->          kept only with a links.repoUrl
//   <!-- passgen:license-link --> … <!-- /passgen:license-link -->    kept only with a links.licenseUrl
//   <!-- passgen:version -->                     the package version, from the build
//   data-cfg-text="path"      element content: the value at that configuration path
//   data-cfg-chars="path"     element content: the string's characters, space separated
//   data-cfg-min|max|value="path"   that attribute, from the value at the path
//   data-cfg-href="path"      an href attribute, from the configured link at the path
//   data-cfg-checked="path"   `checked` when the value is true
//   data-cfg-checked-eq="path"  `checked` when the value equals the element's value attribute
//   data-cfg-options="path" data-cfg-selected="path"  <option>s for each character of the string
//   data-cfg-selected="path"  selected option in a fixed-option select
//
// Every marker and data-cfg attribute must be consumed; a leftover fails the
// build, as does a path that names nothing or names an object.

export interface PageConfig {
  readonly passphrase: {
    readonly wordLists: {
      readonly default: string;
      readonly offered: Array<{ id: string; defaultMin: number; defaultMax: number }>;
    };
  };
  readonly theme: string;
  readonly style: {
    readonly default: string;
    readonly offered: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  };
  readonly text: {
    readonly tagline: string;
    readonly intro: { readonly enabled: boolean; readonly headline: string; readonly text: string };
  };
  /** The outward links, each an https URL the validator accepted or empty (decision 0005). */
  readonly links: { readonly repoUrl: string; readonly licenseUrl: string };
}

/** What the build knows that the configuration does not. */
export interface BuildInfo {
  /** The version from package.json, shown in the footer. */
  readonly version: string;
}

/** A version the footer may show: digits and dots, with an optional pre-release suffix. */
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/;

/** Text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Readable names for the ASCII punctuation a separator dropdown can offer (R14). */
export const SYMBOL_NAMES: Readonly<Record<string, string>> = {
  "!": "exclamation mark",
  '"': "double quote",
  "#": "hash",
  $: "dollar",
  "%": "percent",
  "&": "ampersand",
  "'": "apostrophe",
  "(": "left parenthesis",
  ")": "right parenthesis",
  "*": "asterisk",
  "+": "plus",
  ",": "comma",
  "-": "hyphen",
  ".": "period",
  "/": "slash",
  ":": "colon",
  ";": "semicolon",
  "<": "less than",
  "=": "equals",
  ">": "greater than",
  "?": "question mark",
  "@": "at",
  "[": "left bracket",
  "\\": "backslash",
  "]": "right bracket",
  "^": "caret",
  _: "underscore",
  "`": "backtick",
  "{": "left brace",
  "|": "vertical bar",
  "}": "right brace",
  "~": "tilde",
};

const PATH = /^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/;

/** The scalar at a dotted path of the configuration. */
export function configValue(config: unknown, path: string): string | number | boolean {
  if (!PATH.test(path)) throw new Error(`index.html: bad configuration path "${path}"`);
  let value: unknown = config;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error(`index.html: configuration has no "${path}"`);
    value = (value as Record<string, unknown>)[key];
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
    throw new Error(`index.html: "${path}" is not a string, number or boolean`);
  return value;
}

function section(html: string, name: string, keep: boolean): string {
  const open = `<!-- passgen:${name} -->`;
  const close = `<!-- /passgen:${name} -->`;
  const start = html.indexOf(open);
  const end = html.indexOf(close);
  if (start < 0 || end < 0 || end < start || html.indexOf(open, start + 1) >= 0 || html.indexOf(close, end + 1) >= 0)
    throw new Error(`index.html: expected exactly one ${open} … ${close} section`);
  const inner = html.slice(start + open.length, end);
  return html.slice(0, start) + (keep ? inner : "") + html.slice(end + close.length);
}

function marker(html: string, name: string, replacement: string): string {
  const tag = `<!-- passgen:${name} -->`;
  if (html.split(tag).length !== 2) throw new Error(`index.html: expected exactly one ${tag}`);
  return html.replace(tag, () => replacement);
}

/** The tag name and attribute text of an opening tag whose attributes include `attribute="…"`. */
const TAG = (attribute: string) =>
  new RegExp(
    `<([a-z][a-z0-9-]*)((?:\\s+[^\\s=>]+(?:="[^"]*")?)*)\\s+${attribute}="([^"]*)"((?:\\s+[^\\s=>]+(?:="[^"]*")?)*)\\s*>`,
    "g",
  );

/** Replaces an empty element's content, keeping the other attributes. */
function fillContent(html: string, attribute: string, content: (path: string) => string): string {
  const pattern = new RegExp(`${TAG(attribute).source}\\s*</\\1>`, "g");
  return html.replace(pattern, (_m, tag: string, before: string, path: string, after: string) => {
    return `<${tag}${before}${after}>${content(path)}</${tag}>`;
  });
}

/** Rewrites one data-cfg attribute into a real attribute (or nothing). */
function rewriteAttribute(html: string, attribute: string, rewrite: (path: string, tagText: string) => string): string {
  return html.replace(TAG(attribute), (_m, tag: string, before: string, path: string, after: string) => {
    const replacement = rewrite(path, `${before}${after}`);
    return `<${tag}${before}${after}${replacement === "" ? "" : ` ${replacement}`}>`;
  });
}

function stringAt(config: PageConfig, path: string): string {
  return String(configValue(config, path));
}

/**
 * The built page: markers resolved, data-cfg attributes replaced, text
 * escaped. Throws on a marker or path problem, so the build fails closed.
 */
export function renderPage(html: string, config: PageConfig, build: BuildInfo): string {
  if (!VERSION.test(build.version))
    throw new Error(`index.html: "${build.version}" is not a version the page can show`);
  const lists = config.passphrase.wordLists;
  if (!isWordListId(lists.default)) throw new Error("Unknown default word list");
  const selected = lists.offered.find((entry) => entry.id === lists.default);
  if (!selected) throw new Error("Default word list is not offered");
  const bounds = WORD_LISTS[lists.default];
  // Derived defaults are template data only, never another deployment setting.
  const templateConfig = {
    ...config,
    passphrase: {
      ...config.passphrase,
      wordLength: {
        min: bounds.min,
        max: bounds.max,
        defaultMin: selected.defaultMin,
        defaultMax: selected.defaultMax,
      },
    },
  };
  let out = html;
  out = section(out, "word-list-control", lists.offered.length > 1);
  if (lists.offered.length > 1)
    out = marker(
      out,
      "word-list-options",
      lists.offered
        .map(({ id }) => {
          if (!isWordListId(id)) throw new Error("Unknown word list");
          return `<option value="${id}"${id === lists.default ? " selected" : ""}>${escapeHtml(WORD_LISTS[id].name)}</option>`;
        })
        .join(""),
    );
  out = marker(out, "word-list-description", escapeHtml(wordListDescription(lists.default)));
  out = marker(
    out,
    "word-list-credits",
    wordListCredits(config)
      .map(
        ({ id, name, count, source }) =>
          `<li data-word-list="${id}">${escapeHtml(name)} — ${escapeHtml(source.author)} · <a data-wordlist-credit="license" href="${source.licenseUrl}" rel="noopener noreferrer">${source.license}</a> · <a data-wordlist-credit="source" href="${source.url}" rel="noopener noreferrer">Source</a> · ${count.toLocaleString("en-US")} usable words</li>`,
      )
      .join(""),
  );
  if (out.split(BOOT_MARKER).length !== 2) throw new Error(`index.html: expected exactly one ${BOOT_MARKER}`);
  out = section(out, "intro", config.text.intro.enabled);
  out = section(out, "tagline", config.text.tagline.trim() !== "");
  out = section(out, "style-control", config.style.offered.length > 1);
  out = section(out, "repo-link", config.links.repoUrl !== "");
  out = section(out, "license-link", config.links.licenseUrl !== "");
  out = marker(out, "version", escapeHtml(build.version));
  const styleOptions = config.style.offered
    .map(({ id, label }) => {
      const selected = id === config.style.default ? " selected" : "";
      return `<option value="${escapeHtml(id)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
  if (config.style.offered.length > 1) out = marker(out, "style-options", styleOptions);

  out = fillContent(out, "data-cfg-text", (path) => escapeHtml(stringAt(templateConfig, path)));
  out = fillContent(out, "data-cfg-chars", (path) => escapeHtml([...stringAt(templateConfig, path)].join(" ")));
  for (const name of ["min", "max", "value"] as const) {
    out = rewriteAttribute(
      out,
      `data-cfg-${name}`,
      (path) => `${name}="${escapeHtml(stringAt(templateConfig, path))}"`,
    );
  }
  out = rewriteAttribute(out, "data-cfg-checked", (path) =>
    configValue(templateConfig, path) === true ? "checked" : "",
  );
  // A link the validator accepted (an https URL) or nothing: an empty link
  // has no element to carry it, since its section is left out above.
  out = rewriteAttribute(out, "data-cfg-href", (path) => {
    const url = stringAt(templateConfig, path);
    if (!/^https:\/\/\S+$/.test(url)) throw new Error(`index.html: "${path}" is not an https URL`);
    return `href="${escapeHtml(url)}"`;
  });
  out = rewriteAttribute(out, "data-cfg-checked-eq", (path, tagText) => {
    const own = tagText.match(/\svalue="([^"]*)"/)?.[1];
    if (own === undefined) throw new Error(`index.html: data-cfg-checked-eq="${path}" needs a value attribute`);
    return stringAt(templateConfig, path) === own ? "checked" : "";
  });
  // A select whose options are the characters of a configured string.
  const SELECT =
    /<select((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s+data-cfg-options="([^"]*)"\s+data-cfg-selected="([^"]*)"((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*>\s*<\/select>/g;
  out = out.replace(SELECT, (_m, before: string, path: string, selectedPath: string, after: string) => {
    const chosen = stringAt(templateConfig, selectedPath);
    const options = [...stringAt(templateConfig, path)]
      .map((char) => {
        const name = SYMBOL_NAMES[char];
        const label = name === undefined ? char : `${char} ${name}`;
        return `<option value="${escapeHtml(char)}"${char === chosen ? " selected" : ""}>${escapeHtml(label)}</option>`;
      })
      .join("");
    const modes = [
      ["random", "Random"],
      ["random-unique", "Random (unique)"],
    ]
      .map(([value, label]) => `<option value="${value}"${value === chosen ? " selected" : ""}>${label}</option>`)
      .join("");
    return `<select${before}${after}>${options}${modes}</select>`;
  });

  // Fixed-option selects use the same config defaults as the runtime store.
  out = out.replace(
    /<select([^>]*?)\sdata-cfg-selected="([^"]*)"([^>]*)>([\s\S]*?)<\/select>/g,
    (_match, before: string, path: string, after: string, options: string) => {
      const chosen = stringAt(templateConfig, path);
      const filled = options.replace(/<option value="([^"]*)">/g, (tag: string, value: string) =>
        value === chosen ? tag.replace(">", " selected>") : tag,
      );
      return `<select${before}${after}>${filled}</select>`;
    },
  );

  const leftover = out.match(/data-cfg-[a-z-]+=|<!-- \/?passgen:(?!(?:csp|boot) -->)[a-z-]+ -->/);
  if (leftover) throw new Error(`index.html: unresolved template marker ${leftover[0]}`);
  return out;
}

const BOOT_MARKER = "<!-- passgen:boot -->";

/**
 * Replaces the boot marker with the render-blocking script tag. Done after
 * the bundler has processed the page, so the classic script is left alone.
 */
export function insertBootScript(html: string, src: string): string {
  if (html.split(BOOT_MARKER).length !== 2) throw new Error(`index.html: expected exactly one ${BOOT_MARKER}`);
  return html.replace(BOOT_MARKER, () => `<script src="${escapeHtml(src)}"></script>`);
}
