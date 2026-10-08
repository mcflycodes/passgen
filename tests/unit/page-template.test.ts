import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  configValue,
  escapeHtml,
  insertBootScript,
  renderPage,
  SYMBOL_NAMES,
} from "../../scripts/lib/page-template.ts";
import config from "../../src/config/config.json" with { type: "json" };

const ROOT = join(import.meta.dirname, "../..");
const INDEX = readFileSync(join(ROOT, "index.html"), "utf8");
const page = (edit: (c: typeof config) => void = () => {}) => {
  const copy = structuredClone(config);
  edit(copy);
  return insertBootScript(renderPage(INDEX, copy), "./assets/boot-x.js");
};

describe("escaping", () => {
  test("escapes the five HTML-significant characters", () => {
    assert.equal(escapeHtml(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&#39;f");
  });
  test("reads scalars at a dotted path and refuses anything else", () => {
    assert.equal(configValue(config, "password.length.default"), 20);
    assert.equal(configValue(config, "text.intro.enabled"), true);
    assert.throws(() => configValue(config, "password.length"), /not a string, number or boolean/);
    assert.throws(() => configValue(config, "nope.x"), /has no "nope.x"/);
    assert.throws(() => configValue(config, "__proto__.x"), /bad configuration path/);
    assert.throws(() => configValue(config, "constructor.name"), /has no/);
    assert.throws(() => configValue(config, "a..b"), /bad configuration path/);
  });
});

describe("the shipped index.html", () => {
  test("renders the page text, the defaults and the style options from the configuration", () => {
    const html = page();
    assert.match(html, /<p class="tagline">Password generator · Runs entirely in your browser<\/p>/);
    assert.match(html, /<h2 class="headline" id="intro-headline">Strong by default\.<\/h2>/);
    assert.match(html, /<p class="lede">Open the page, copy a password, done\./);
    assert.match(html, /<input type="range" id="pw-length" min="4" max="128" value="20">/);
    assert.match(html, /<input type="range" id="pp-words" min="2" max="12" value="5">/);
    assert.match(html, /id="pw-lowercase" checked>/);
    assert.match(html, /id="pw-lookalikes">/);
    assert.match(html, /id="theme-system" value="system" checked>/);
    assert.match(html, /id="theme-dark" value="dark">/);
    assert.match(html, /<option value="calm" selected>Calm<\/option><option value="payload">Payload<\/option>/);
    assert.match(html, /<option value="-" selected>- hyphen<\/option>/);
    assert.match(html, /<option value="\?">\? question mark<\/option>/);
    assert.match(html, /<script src="\.\/assets\/boot-x\.js"><\/script>/);
    assert.doesNotMatch(html, /data-cfg-/);
    assert.doesNotMatch(html, /passgen:(?!csp)/);
    assert.match(html, /<!-- passgen:csp -->/, "the CSP placeholder is left for its own plugin");
    assert.match(html, /<!-- biome-ignore/, "lint directives stay as comments");
  });

  test("escapes the inserted text", () => {
    const html = page((c) => {
      c.text.tagline = `<b>bold</b> & "quoted" 'ok'`;
      c.text.intro.headline = "<script>alert(1)</script>";
      (c.style.offered[0] as { label: string }).label = `C<a>lm "x"`;
    });
    assert.match(html, /&lt;b&gt;bold&lt;\/b&gt; &amp; &quot;quoted&quot; &#39;ok&#39;/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /<option value="calm" selected>C&lt;a&gt;lm &quot;x&quot;<\/option>/);
  });

  test("leaves the intro out when disabled, and the tagline when empty", () => {
    const html = page((c) => {
      c.text.intro.enabled = false;
      c.text.tagline = "";
    });
    assert.doesNotMatch(html, /class="intro"/);
    assert.doesNotMatch(html, /class="tagline"/);
    assert.match(html, /<main>\s*<div class="generators">/);
  });

  test("leaves the style control out with one offered style", () => {
    const html = page((c) => {
      c.style.offered = [{ id: "payload", label: "Payload" }];
      c.style.default = "payload";
    });
    assert.doesNotMatch(html, /id="style"/);
    assert.doesNotMatch(html, /<option value="payload"/);
    assert.doesNotMatch(html, /Style</);
  });

  test("checks the configured default theme", () => {
    assert.match(
      page((c) => {
        c.theme = "dark";
      }),
      /id="theme-dark" value="dark" checked>/,
    );
  });

  test("names every simple symbol the shipped configuration offers", () => {
    for (const char of config.password.characters.simple) assert.ok(SYMBOL_NAMES[char], `name for ${char}`);
  });
});

describe("template errors fail closed", () => {
  const render = (html: string) => renderPage(html, config);
  test("a path that names nothing", () => {
    assert.throws(
      () => render(INDEX.replace('data-cfg-text="text.tagline"', 'data-cfg-text="text.nope"')),
      /has no "text.nope"/,
    );
  });
  test("a leftover attribute the template does not know", () => {
    assert.throws(
      () => render(INDEX.replace('data-cfg-text="text.tagline"', 'data-cfg-html="text.tagline"')),
      /unresolved template marker data-cfg-html=/,
    );
  });
  test("a duplicated or missing section marker", () => {
    assert.throws(() => render(INDEX.replace("<!-- /passgen:intro -->", "")), /exactly one <!-- passgen:intro -->/);
    assert.throws(() => render(`${INDEX}<!-- passgen:intro -->`), /exactly one/);
  });
  test("a missing boot marker", () => {
    assert.throws(() => render(INDEX.replace("<!-- passgen:boot -->", "")), /passgen:boot/);
    assert.throws(() => insertBootScript("<head></head>", "./x.js"), /passgen:boot/);
  });
  test("a checked-eq input without a value attribute", () => {
    assert.throws(
      () => render(INDEX.replace('value="system" data-cfg-checked-eq="theme"', 'data-cfg-checked-eq="theme"')),
      /needs a value attribute/,
    );
  });
});
