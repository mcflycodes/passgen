import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { type BootScript, compileBootScript } from "./scripts/lib/boot-script.ts";
import { parseConfigJson } from "./scripts/lib/config-json.ts";
import { checkHtmlSinks } from "./scripts/lib/html-sink-scan.ts";
import { type BuildInfo, insertBootScript, renderPage } from "./scripts/lib/page-template.ts";
import { assertStyles, styleSheet } from "./scripts/lib/style-checks.ts";
import { checkWordlist } from "./scripts/lib/wordlist.ts";
import { metaCsp } from "./security/headers.ts";
import { SETTINGS_STORAGE_KEY, SETTINGS_TEXT_LIMIT, storedLimits } from "./src/boot/storage.ts";
import { type Config, validateConfig } from "./src/config/validate.ts";

const CSP_PLACEHOLDER = "<!-- passgen:csp -->";

// Replaces the placeholder in index.html with the CSP <meta> tag generated from
// security/headers.ts (decision 0005, requirement H2). Build only: the dev
// server injects its own inline client script, which this policy would block.
function metaCspPlugin(): Plugin {
  return {
    name: "passgen-meta-csp",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (html.split(CSP_PLACEHOLDER).length !== 2) {
          throw new Error(`index.html must contain exactly one ${CSP_PLACEHOLDER} placeholder`);
        }
        return html.replace(CSP_PLACEHOLDER, `<meta http-equiv="Content-Security-Policy" content="${metaCsp()}">`);
      },
    },
  };
}

/** The module main.ts imports to load the offered styles' stylesheets (C1). */
const STYLES_MODULE = "virtual:passgen-styles";
const RESOLVED_STYLES_MODULE = `\0${STYLES_MODULE}`;
/** Where the dev server serves the boot script; the build emits it under assets/. */
const DEV_BOOT_PATH = "/__passgen/boot.js";

// Validates the configuration and the offered styles before anything is
// built (C2, R4b), fills index.html from the configuration (R4d, C1),
// provides the styles module, and compiles the render-blocking boot script
// that applies the theme and style before the first paint (R4, R4a). Two
// plugins because the page is filled before the bundler processes it and
// the classic boot script tag is inserted after, so it is never bundled.
function passgenPagePlugins(): Plugin[] {
  let config: Config;
  let boot: BootScript;
  let build: BuildInfo;
  return [
    {
      name: "passgen-page",
      async configResolved(resolved) {
        const sinks = await checkHtmlSinks(join(resolved.root, "src"));
        if (sinks.length) throw new Error(sinks.join("\n"));
        checkWordlist(resolved.root);
        const shipped: unknown = parseConfigJson(readFileSync(join(resolved.root, "src/config/config.json"), "utf8"));
        validateConfig(shipped);
        config = shipped;
        assertStyles(resolved.root, config.style);
        // The footer shows the version of this checkout's package.json (the
        // repository's, not the root's: the gate tests build copies elsewhere).
        const pkg: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8"));
        const version = (pkg as { version?: unknown }).version;
        if (typeof version !== "string") throw new Error("package.json has no version");
        build = { version };
        boot = await compileBootScript(resolved.root, {
          theme: config.theme,
          style: config.style.default,
          key: SETTINGS_STORAGE_KEY,
          textLimit: SETTINGS_TEXT_LIMIT,
          limits: storedLimits(config),
        });
      },
      resolveId(id) {
        return id === STYLES_MODULE ? RESOLVED_STYLES_MODULE : null;
      },
      load(id) {
        if (id !== RESOLVED_STYLES_MODULE) return null;
        return config.style.offered.map((s) => `import "/${styleSheet(s.id)}";`).join("\n");
      },
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          return renderPage(html, config, build);
        },
      },
      generateBundle() {
        this.emitFile({ type: "asset", fileName: boot.fileName, source: boot.code });
      },
      configureServer(server) {
        server.middlewares.use(DEV_BOOT_PATH, (_req, res) => {
          res.setHeader("content-type", "text/javascript; charset=utf-8");
          res.end(boot.code);
        });
      },
    },
    {
      name: "passgen-boot-script",
      transformIndexHtml: {
        order: "post",
        handler(html, ctx) {
          return insertBootScript(html, ctx.server ? DEV_BOOT_PATH : `./${boot.fileName}`);
        },
      },
    },
  ];
}

export default defineConfig({
  // Relative asset paths, so one build works at any domain or subpath.
  base: "./",
  plugins: [...passgenPagePlugins(), metaCspPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // No data: URIs: the CSP allows images and fonts from 'self' only.
    assetsInlineLimit: 0,
    // Every supported browser has modulepreload; skip the injected polyfill.
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: "es2022",
  },
});
