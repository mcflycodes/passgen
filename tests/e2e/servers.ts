// The three local servers playwright.config.ts starts, all serving the build:
// the page at the root with the reference headers, the same build under a
// subpath, and the build on a "host" that sets no headers, to prove the
// in-page CSP holds on its own.
import { join, resolve } from "node:path";

/** The build folder under test: dist/, or PASSGEN_DIST for the gate regressions. */
export const DIST_DIR = resolve(process.env.PASSGEN_DIST ?? join(import.meta.dirname, "..", "..", "dist"));

export const ORIGINS = {
  root: "http://127.0.0.1:4173",
  subpath: "http://127.0.0.1:4174",
  noHeaders: "http://127.0.0.1:4175",
} as const;

export const SUBPATH = "/tools/passgen/";
