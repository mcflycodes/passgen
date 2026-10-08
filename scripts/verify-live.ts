// Usage: node scripts/verify-live.ts --url https://example.com/ --manifest dist-manifest/SHA256SUMS
import { parseArgs } from "node:util";
import { verifyLive } from "./lib/live-checks.ts";

try {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      manifest: { type: "string" },
      "release-dir": { type: "string" },
      "local-http": { type: "boolean" },
    },
  });
  if (!values.url || !values.manifest) throw new Error("--url and --manifest are required");
  const count = await verifyLive({
    url: values.url,
    manifest: values.manifest,
    ...(values["release-dir"] ? { releaseDir: values["release-dir"] } : {}),
    ...(values["local-http"] ? { localHttp: true } : {}),
  });
  console.log(
    `PASS: ${count} file hashes, exact security headers (including CSP), HEAD, method refusal and no listing.`,
  );
  console.log(
    values["release-dir"]
      ? "Local release file set matches exactly."
      : "LIMIT: HTTP cannot enumerate extra hidden or unlinked files; use --release-dir for file-set equality.",
  );
  if (values["local-http"]) console.log("LOCAL TEST: HTTPS certificate validation was not tested.");
} catch (error) {
  console.error(`FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
}
