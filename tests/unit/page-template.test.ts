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
const BUILD = { version: "1.2.3" };
const page = (edit: (c: typeof config) => void = () => {}, build = BUILD) => {
  const copy = structuredClone(config);
  edit(copy);
  return insertBootScript(renderPage(INDEX, copy, build), "./assets/boot-x.js");
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
    assert.match(html, /<option value="random" selected>Random<\/option>/);
    assert.match(html, /<option value="\?">\? question mark<\/option>/);
    assert.match(html, /<script src="\.\/assets\/boot-x\.js"><\/script>/);
    assert.match(html, /<span class="foot-version">v1\.2\.3<\/span>/);
    assert.doesNotMatch(html, /data-cfg-/);
    assert.doesNotMatch(html, /passgen:(?!csp)/);
    assert.match(html, /<!-- passgen:csp -->/, "the CSP placeholder is left for its own plugin");
    assert.match(html, /<!-- biome-ignore/, "lint directives stay as comments");
  });

  test("fixed-option passphrase controls reflect configured defaults", () => {
    const html = page((c) => {
      c.passphrase.separator.numberDigits.default = 3;
      c.passphrase.separator.symbolPosition = "after";
      c.passphrase.capitalize = "every";
    });
    assert.match(html, /<option value="3" selected>3 digits<\/option>/);
    assert.match(html, /<option value="after" selected>After<\/option>/);
    assert.match(html, /<option value="every" selected>Every word<\/option>/);
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

  test("renders the configured links as plain anchors with rel=noopener noreferrer", () => {
    const html = page();
    assert.match(
      html,
      /<a class="top-link" id="repo-link" rel="noopener noreferrer" aria-label="GitHub" title="GitHub" href="https:\/\/github\.com\/mcflycodes\/passgen">\s*<svg[^>]*>[\s\S]*?<\/svg>\s*<\/a>/,
    );
    assert.match(
      html,
      /<a class="foot-link" id="license-link" rel="noopener noreferrer" aria-label="Apache-2\.0 license" href="https:\/\/github\.com\/mcflycodes\/passgen\/blob\/main\/LICENSE">Apache-2\.0<\/a>/,
    );
    assert.doesNotMatch(html, /target=/);
    assert.equal(html.match(/<a\b/g)?.length, 12, "configured links and per-list credits");
  });

  test("leaves each link out when its URL is empty, with its separator", () => {
    const noRepo = page((c) => {
      c.links.repoUrl = "";
    });
    assert.doesNotMatch(noRepo, /id="repo-link"/);
    assert.doesNotMatch(noRepo, /GitHub/);
    assert.match(noRepo, /id="license-link"/);
    const noLicense = page((c) => {
      c.links.licenseUrl = "";
    });
    assert.doesNotMatch(noLicense, /id="license-link"/);
    assert.equal(noLicense.match(/class="foot-sep"/g)?.length, 1);
    assert.match(noLicense, /id="repo-link"/);
    const none = page((c) => {
      c.links.repoUrl = "";
      c.links.licenseUrl = "";
    });
    assert.equal(none.match(/<a\b/g)?.length, 10);
    assert.match(none, /<span class="foot-version">v1\.2\.3<\/span>/);
  });

  test("escapes a link's characters and refuses anything but an https URL in an href", () => {
    const html = page((c) => {
      c.links.repoUrl = 'https://example.invalid/a"b&c';
    });
    assert.match(html, /href="https:\/\/example\.invalid\/a&quot;b&amp;c"/);
    for (const url of ["javascript:alert(1)", "http://example.invalid/", "./LICENSE", "https://"]) {
      assert.throws(
        () =>
          page((c) => {
            c.links.licenseUrl = url;
          }),
        /is not an https URL/,
        url,
      );
    }
  });

  test("refuses a version the footer cannot show", () => {
    for (const version of ["", "1.2", "v1.2.3", "1.2.3 beta", "1.2.3-<b>", "1.2.3.4"]) {
      assert.throws(() => page(() => {}, { version }), /not a version the page can show/, JSON.stringify(version));
    }
    assert.match(
      page(() => {}, { version: "2.0.0-rc.1" }),
      /v2\.0\.0-rc\.1/,
    );
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
  const render = (html: string) => renderPage(html, config, BUILD);
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
  test("a missing version marker", () => {
    assert.throws(() => render(INDEX.replace("<!-- passgen:version -->", "")), /exactly one <!-- passgen:version -->/);
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
