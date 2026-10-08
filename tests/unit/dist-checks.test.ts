import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { EXAMPLE_TOOLS } from "../../scripts/lib/attribution-patterns.ts";
import {
  checkCss,
  checkFile,
  checkHtml,
  checkJs,
  cspMetaTag,
  findHostnames,
  findProviderFiles,
  resolveWithinDist,
  TLD_LIST_PATH,
  TLDS,
} from "../../scripts/lib/dist-checks.ts";

const META = cspMetaTag();
const HEAD_START = `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8">\n    ${META}`;

function page(afterCsp = "", body = "<main><h1>PassGen</h1></main>"): string {
  return `${HEAD_START}\n    <title>PassGen</title>${afterCsp}\n  </head>\n  <body>${body}</body>\n</html>\n`;
}

const flagged = (findings: readonly unknown[]) => findings.length > 0;

describe("TLD snapshot", () => {
  test("is IANA's root zone list with a recorded version", () => {
    assert.match(readFileSync(TLD_LIST_PATH, "utf8"), /^# Version \d{10}, Last Updated /);
    assert.ok(TLDS.size > 1000);
    for (const tld of ["com", "io", "dev", "education", "app"]) assert.ok(TLDS.has(tld), tld);
    for (const name of ["copy", "settings", "js", "html", "css", "svg"]) assert.ok(!TLDS.has(name), name);
  });
});

describe("host name check", () => {
  for (const bad of [
    "example.education",
    "a.com",
    "x.io",
    "foo.dev",
    "passgen.example.com",
    "evil.example",
    "host.internal",
    "_evil.com_",
    "a.com.js",
    "user@mail.example.org",
    "https://example.invalid/x.js",
    "wss://socket.example",
    "//cdn.example.invalid/lib.js",
    "localhost",
    "10.0.0.1",
    "[::1]",
    "http://www.w3.org/2000/svg",
  ]) {
    test(`flags ${bad}`, () => {
      assert.ok(flagged(findHostnames("f", bad)), bad);
    });
  }

  for (const ok of [
    "button.copy",
    "passgen.settings",
    "a.min.js",
    "index-abc.js favicon.svg index.html",
    "crypto.getRandomValues",
    "version 1.2.3 and 0.5",
    "e.g. this",
  ]) {
    test(`allows ${ok}`, () => {
      assert.deepEqual(findHostnames("f", ok), []);
    });
  }
});

describe("HTML structural rule", () => {
  test("accepts the charset and exact CSP as the first two elements of <head>", () => {
    assert.deepEqual(checkHtml("index.html", page('<script type="module" src="./a.js"></script>')), []);
  });

  test("allows character references in the rest of the page (checked decoded in the browser test)", () => {
    assert.deepEqual(checkHtml("index.html", page("", "<label>Symbols: &amp; &lt; &#33;</label>")), []);
  });

  const cases: Array<[string, string]> = [
    [
      "http-equiv with surrounding spaces",
      page().replace('http-equiv="Content-Security-Policy"', 'http-equiv=" Content-Security-Policy "'),
    ],
    ["CSP inside a <template> in <head>", page().replace(`    ${META}`, `    <template>${META}</template>`)],
    ["a <div> in <head> before the CSP", page().replace(`    ${META}`, `    <div></div>${META}`)],
    ["missing CSP", page().replace(META, "")],
    [
      "CSP before charset",
      page().replace(`<meta charset="utf-8">\n    ${META}`, `${META}\n    <meta charset="utf-8">`),
    ],
    ["a <script> before the CSP", page().replace(`    ${META}`, `    <script src="./a.js"></script>${META}`)],
    ["weaker CSP", page().replace("connect-src 'none'", "connect-src *")],
    ["single-quoted CSP", page().replace(META, META.replaceAll('"', "'"))],
    ["second CSP meta", page(META)],
    ["report-only CSP added", page('<meta http-equiv="Content-Security-Policy-Report-Only" content="x">')],
    ["meta refresh", page('<meta http-equiv="refresh" content="0;url=./x">')],
    ["host name in text", page("", "<p>Visit example.education</p>")],
    ["absolute URL", page('<link rel="icon" href="https://example.invalid/i.png">')],
    ["leading comment", `<!-- x -->${page()}`],
  ];
  for (const [label, html] of cases) {
    test(`rejects ${label}`, () => {
      assert.ok(flagged(checkHtml("index.html", html)), label);
    });
  }
});

describe("JavaScript check (oxc)", () => {
  test("ignores property access and code outside literals", () => {
    assert.deepEqual(
      checkJs("a.js", "e.app=1;t.dev=2;el.style.top=x.name;crypto.getRandomValues(new Uint32Array(1));"),
      [],
    );
  });

  test("allows module and asset paths inside the build", () => {
    assert.deepEqual(
      checkJs("assets/a.js", 'import "./b.js"; import("../c.js"); new URL("../favicon.svg", import.meta.url);'),
      [],
    );
  });

  for (const js of [
    'new URL("../../outside.png", import.meta.url)',
    'import("../../outside.js")',
    'import x from "/outside.js"',
    'export * from "%2e%2e/%2e%2e/outside.js"',
  ]) {
    test(`rejects a path out of the build: ${js}`, () => {
      assert.ok(flagged(checkJs("assets/a.js", js)), js);
    });
  }

  test("does not mistake a division after ++ for a regular expression", () => {
    assert.deepEqual(checkJs("a.js", "let count=4;const half=count++/2;"), []);
  });

  for (const [label, js] of [
    ["regex after if(…)", "if(ok) /evil\\.example/.test(s);"],
    ["double-quoted string", 'const u="example.education";'],
    ["single-quoted string", "const u='a.com';"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source used as a fixture
    ["template text after a substitution", "const u=`${a}.evil.app`;"],
    ["hex-escaped dot", 'const u="evil\\x2ecom";'],
    ["unicode-escaped dot", 'const u="evil\\u002ecom";'],
    ["scheme-relative string", 'const u="//cdn";'],
    ["block comment", "/* see evil.example */ x=1;"],
    ["line comment", "x=1; // see evil.example"],
    ["URL in code", "x=1; // https://evil.example"],
    ["dynamic import", 'import("https://evil.example/x.js")'],
    ["syntax error", 'const u="abc'],
  ] as const) {
    test(`flags ${label}`, () => {
      assert.ok(flagged(checkJs("a.js", js)), js);
    });
  }
});

describe("CSS check (lightningcss)", () => {
  test("allows plain selectors, gradients and tokens", () => {
    assert.deepEqual(
      checkCss("a.css", "button.copy:hover{top:0}a{background:linear-gradient(#000,#fff)}:root{--a:1px}"),
      [],
    );
  });

  test("reports a relative URL inside the build as a resource, with no path finding", () => {
    const found = checkCss("a.css", "a{background:url(./x.png)}b{background:url('img/y.svg')}").map((f) => f.problem);
    assert.deepEqual(found, ["CSS loads a resource: url(./x.png)", "CSS loads a resource: url(img/y.svg)"]);
  });

  for (const [label, css] of [
    ["@import with a comment before the string", '@import/**/"/outside.css";a{b:c}'],
    ["relative @import", '@import "./other.css";'],
    ["escaped url( function", "a{background:u\\72l(/outside.png)}"],
    ["image-set() string", 'a{background-image:image-set("/other.png" 1x)}'],
    ["absolute url()", "a{background:url(https://evil.example/x.png)}"],
    ["root-relative url()", "a{background:url(/x.png)}"],
    ["scheme-relative url()", "a{background:url('//evil.example/x.png')}"],
    ["escape in a string spelling a host", 'a::after{content:"evil\\2e com"}'],
    ["escaped host in a font name", 'a{font-family:"evil\\2e com"}'],
    ["host in a string", 'a::after{content:"evil.example"}'],
    ["host in a comment", "/* evil.example */a{}"],
    ["parse error", "a{color:red}}"],
  ] as const) {
    test(`flags ${label}`, () => {
      assert.ok(flagged(checkCss("a.css", css)), css);
    });
  }
});

describe("CSS attribution (lightningcss decoded strings)", () => {
  const toolA = EXAMPLE_TOOLS.find((t) => t.toLowerCase() === "cursor") as string;
  const toolB = EXAMPLE_TOOLS.find((t) => t.toLowerCase() === "pi") as string;
  const escaped = `${toolA[0]}\\${(toolA.codePointAt(1) as number).toString(16)} ${toolA.slice(2)}`;
  for (const [label, css] of [
    ["content with an escaped letter", `footer::after{content:"Generated by ${escaped}"}`],
    [
      "content split into adjacent strings",
      `footer::after{content:"Generated by ${toolA.slice(0, 2)}" "${toolA.slice(2)}"}`,
    ],
    ["quotes", `q{quotes:"Made with ${toolA}" "x"}`],
    ["list-style string", `ol{list-style:"Built with ${toolB}"}`],
    ["@counter-style symbols", `@counter-style x{system:cyclic;symbols:"Powered" "by" "${toolB}"}`],
  ] as const) {
    test(`flags ${label}`, () => {
      assert.ok(
        checkCss("assets/a.css", css).some((f) => f.problem.startsWith("attribution:")),
        css,
      );
    });
  }

  test("allows ordinary generated content", () => {
    assert.deepEqual(checkCss("assets/a.css", 'a::after{content:"\\2713"} q{quotes:"\\201C" "\\201D"}'), []);
  });
});

describe("SVG check", () => {
  const svg = (rest: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${rest}</svg>`;

  test("allows the shipped favicon shape", () => {
    assert.deepEqual(checkFile("i.svg", svg("<title>x</title><rect/>")), []);
  });

  for (const [label, text] of [
    [
      "namespace with a host appended",
      '<svg xmlns="http://www.w3.org/2000/svg.attacker.education/x" viewBox="0 0 1 1"></svg>',
    ],
    ["namespace repeated later", svg('<g xmlns="http://www.w3.org/2000/svg"/>')],
    ["script", svg('<script href="./a.js"></script>')],
    ["event handler", svg('<rect onclick="x()"/>')],
    ["external reference", svg('<image href="./x.png"/>')],
    ["style", svg("<style>rect{}</style>")],
    ["foreignObject", svg("<foreignObject></foreignObject>")],
    ["character reference", svg("<title>evil&#46;example</title>")],
  ] as const) {
    test(`rejects ${label}`, () => {
      assert.ok(flagged(checkFile("i.svg", text)), label);
    });
  }
});

describe("provider file check", () => {
  test("flags provider-specific files anywhere in the build", () => {
    const found = findProviderFiles(["index.html", "_headers", "sub/.htaccess", "netlify.toml", "CNAME"]);
    assert.deepEqual(
      found.map((f) => f.file),
      ["_headers", "sub/.htaccess", "netlify.toml", "CNAME"],
    );
  });
});

describe("resolveWithinDist", () => {
  test("resolves paths inside the build the way a browser would", () => {
    assert.equal(resolveWithinDist("index.html", "./assets/a.js"), "assets/a.js");
    assert.equal(resolveWithinDist("index.html", "favicon.svg?v=1#x"), "favicon.svg");
    assert.equal(resolveWithinDist("assets/a.css", "../favicon.svg"), "favicon.svg");
    assert.equal(resolveWithinDist("index.html", "#top"), "index.html");
    assert.equal(resolveWithinDist("index.html", ""), "index.html");
  });

  test("walks segments without a placeholder base", () => {
    assert.equal(resolveWithinDist("assets/a.css", "../assets/b.css"), "assets/b.css");
    assert.equal(resolveWithinDist("a/b/c.css", "../../x.png"), "x.png");
    assert.equal(resolveWithinDist("index.html", "a/./b/../c.png"), "a/c.png");
  });

  for (const [from, url] of [
    ["assets/a.css", "/__dist__/outside.png"],
    ["assets/a.css", "../../__dist__/outside.png"],
    ["assets/a.css", "../../assets/a.css"],
    ["index.html", "a/../../x"],
    ["index.html", "/favicon.svg"],
    ["index.html", "../x.png"],
    ["assets/a.css", "../../x.png"],
    ["assets/a.css", "%2e%2e/%2E%2E/x.png"],
    ["assets/a.css", "..\\..\\x.png"],
    ["assets/a.css", "..%2f..%2fx.png"],
    ["assets/a.css", "..%5c..%5cx.png"],
    ["index.html", "//evil.example/x"],
    ["index.html", "\\\\evil.example/x"],
    ["index.html", "https://evil.example/x"],
    ["index.html", " /x"],
    ["index.html", "\t/x"],
    ["index.html", "data:text/plain,x"],
    ["index.html", "java\nscript:x"],
    ["index.html", "%zz"],
  ] as const) {
    test(`rejects ${JSON.stringify(url)} from ${from}`, () => {
      assert.equal(resolveWithinDist(from, url), null);
    });
  }
});

describe("CSS resources (R4c, S4)", () => {
  test("the shipped CSS may load nothing: url(), image functions, @import, @font-face and @namespace are reported", () => {
    for (const [css, expected] of [
      [":root{--fx-static:url(/outside.svg)}", /CSS loads a resource: url\(\/outside\.svg\)/],
      ["body{background:url(./a.png)}", /CSS loads a resource: url\(\.\/a\.png\)/],
      [':root{--a:image-set("a.png" 1x)}', /CSS loads a resource: image-set\(\)/],
      ["@font-face{font-family:X;src:local(X)}", /CSS loads a resource: @font-face/],
    ] as const) {
      const found = checkCss("assets/a.css", css).map((f) => f.problem);
      assert.ok(
        found.some((p) => expected.test(p)),
        `${css}: ${JSON.stringify(found)}`,
      );
    }
  });
  test("gradients and tokens are not resources", () => {
    const found = checkCss(
      "assets/a.css",
      ":root{--a:radial-gradient(circle at 1px 1px,#000 1px,transparent 1.6px);--b:1px}body{color:var(--a)}",
    );
    assert.deepEqual(
      found.filter((f) => f.problem.includes("resource")),
      [],
    );
  });
});

test("HTML head permits only the fixed no-translation attribute", () => {
  assert.deepEqual(checkHtml("index.html", page().replace('<html lang="en">', '<html lang="en" translate="no">')), []);
  assert.ok(checkHtml("index.html", page().replace('<html lang="en">', '<html lang="en" translate="yes">')).length);
});
