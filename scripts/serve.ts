// Serves the built page with the reference security headers.
// Usage: node scripts/serve.ts [--dir dist] [--port 4173] [--base /] [--no-headers]
//
// The folder can also come from the PASSGEN_SERVE_DIR environment variable,
// which is how playwright.config.ts passes it: the folder path never becomes
// part of a shell command line. --dir wins over the variable; "dist" is the default.

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createStaticServer } from "./lib/static-server.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    port: { type: "string", default: "4173" },
    host: { type: "string", default: "127.0.0.1" },
    base: { type: "string", default: "/" },
    "no-headers": { type: "boolean", default: false },
  },
});

const dir = resolve(values.dir ?? process.env.PASSGEN_SERVE_DIR ?? "dist");
let isDirectory = false;
try {
  isDirectory = statSync(dir).isDirectory();
} catch {
  // reported below
}
if (!isDirectory) {
  console.error(`Not an existing directory: ${dir}`);
  process.exit(1);
}

const server = createStaticServer({ root: dir, base: values.base, headers: !values["no-headers"] });
server.listen(Number(values.port), values.host, () => {
  const headers = values["no-headers"] ? "without security headers" : "with security headers";
  console.log(`Serving ${dir} at http://${values.host}:${values.port}${values.base} ${headers}`);
});
