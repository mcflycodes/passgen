// Compiles src/boot/theme.ts into the classic, render-blocking script the
// page loads before its stylesheet (R4, R4a, R24, R26). The shared validator
// src/boot/stored-settings.ts is inlined where the source has the include
// marker, its `export` keywords dropped, so the boot script and the app run
// the same code without the boot script being a module. TypeScript is then
// stripped with the transformer Vite already uses, the configured defaults
// replace the `__PASSGEN_BOOT__` placeholder, and the output is minified.
// The file name carries a content hash, so a changed script never serves
// from a stale cache.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { minifySync, transformWithOxc } from "vite";
import type { StoredLimits } from "../../src/boot/stored-settings.ts";

export const BOOT_SOURCE = "src/boot/theme.ts";
const PLACEHOLDER = /\b__PASSGEN_BOOT__\b/;
/** `// __PASSGEN_INCLUDE__ <path>`: the pure module to inline at that line. */
const INCLUDE = /^\/\/ __PASSGEN_INCLUDE__ (\S+)$/m;
/** The block of type-only declarations that stand in for the inlined module while type checking. */
const TYPES_BLOCK = /^\/\/ __PASSGEN_TYPES_BEGIN__\n[\s\S]*?^\/\/ __PASSGEN_TYPES_END__\n/m;

export interface BootDefaults {
  readonly theme: string;
  readonly style: string;
  /** The saved-settings storage key (src/boot/storage.ts). */
  readonly key: string;
  /** The longest stored text the script reads. */
  readonly textLimit: number;
  /** The bounds a stored record must respect (`storedLimits` in src/boot/storage.ts). */
  readonly limits: StoredLimits;
}

export interface BootScript {
  /** The compiled JavaScript. */
  readonly code: string;
  /** The build-relative file name, `assets/boot-<hash>.js`. */
  readonly fileName: string;
}

/**
 * The included module as plain script text: it may contain only comments,
 * type declarations, and `export function` / `export const` declarations,
 * with no imports, so dropping `export` leaves it valid as a script.
 */
export function inlineModule(source: string, path: string): string {
  if (/^\s*import\b/m.test(source)) throw new Error(`${path}: an inlined module cannot import anything`);
  if (/^\s*export\s+default\b/m.test(source))
    throw new Error(`${path}: an inlined module cannot have a default export`);
  const stripped = source.replace(/^export (?=(?:async )?function\b|const\b|interface\b|type\b)/gm, "");
  if (/^\s*export\b/m.test(stripped)) throw new Error(`${path}: only functions, constants and types may be exported`);
  return stripped;
}

export async function compileBootScript(root: string, defaults: BootDefaults): Promise<BootScript> {
  let source = readFileSync(join(root, BOOT_SOURCE), "utf8");
  if (!PLACEHOLDER.test(source)) throw new Error(`${BOOT_SOURCE} must use __PASSGEN_BOOT__ for the defaults`);
  const include = source.match(INCLUDE);
  if (!include) throw new Error(`${BOOT_SOURCE} must include the shared validator with // __PASSGEN_INCLUDE__`);
  const includePath = include[1] as string;
  const included = inlineModule(readFileSync(join(root, includePath), "utf8"), includePath);
  source = source.replace(INCLUDE, () => included);
  if (INCLUDE.test(source)) throw new Error(`${BOOT_SOURCE}: only one include is supported`);
  if (!TYPES_BLOCK.test(source)) throw new Error(`${BOOT_SOURCE} must declare the inlined names in a types block`);
  source = source.replace(TYPES_BLOCK, "");
  const { code: stripped } = await transformWithOxc(source, join(root, BOOT_SOURCE), { lang: "ts" });
  const filled = stripped.replace(new RegExp(PLACEHOLDER.source, "g"), () => JSON.stringify(defaults));
  if (PLACEHOLDER.test(filled)) throw new Error(`${BOOT_SOURCE}: placeholder left after filling`);
  const { code } = minifySync("boot.js", filled, { module: false, compress: true, mangle: true });
  const hash = createHash("sha256").update(code).digest("hex").slice(0, 8);
  return { code, fileName: `assets/boot-${hash}.js` };
}
