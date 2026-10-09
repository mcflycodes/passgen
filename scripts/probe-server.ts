// Runnable against any HTTPS URL; --address selects curl's --resolve target.
import { parseArgs } from "node:util";
import { probeServer } from "./lib/server-probes.ts";

try {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      manifest: { type: "string" },
      "ca-file": { type: "string" },
      address: { type: "string" },
      redirect: { type: "boolean" },
    },
  });
  if (!values.url || !values.manifest) throw new Error("--url and --manifest required");
  await probeServer({
    url: values.url,
    manifest: values.manifest,
    ...(values["ca-file"] ? { caFile: values["ca-file"] } : {}),
    ...(values.address ? { address: values.address } : {}),
    ...(values.redirect ? { redirect: true } : {}),
  });
} catch (error) {
  console.error(`FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
}
