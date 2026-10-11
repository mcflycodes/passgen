// Checks the files scripts/test-container.sh captures from the running image.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { checkImageConfig, checkLogs, checkProcesses, checkResponses } from "./lib/container-checks.ts";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      work: { type: "string" },
      version: { type: "string" },
      revision: { type: "string" },
      architecture: { type: "string" },
    },
  });
  const work = values.work;
  if (!work) throw new Error("--work required");
  const read = (name: string) => readFile(join(work, name), "utf8");
  for (const step of positionals) {
    if (step === "image") {
      if (!values.version || !values.revision || !values.architecture)
        throw new Error("--version, --revision and --architecture required");
      const [inspect] = JSON.parse(await read("inspect.json"));
      checkImageConfig(inspect, {
        version: values.version,
        revision: values.revision,
        architecture: values.architecture,
      });
      console.log("PASS image config: user 101:101, direct nginx entrypoint, wget health check, OCI labels");
    } else if (step === "processes") {
      const count = checkProcesses(await read("proc-status"));
      console.log(`PASS ${count} nginx processes: UID/GID 101, no capabilities, no-new-privileges`);
    } else if (step === "responses") {
      checkResponses({ post: await read("post"), otherHost: await read("other-host"), root: await read("root") });
      console.log("PASS POST is 405 with all headers; any Host is served; Server header has no version");
    } else if (step === "logs") {
      checkLogs(await read("logs.out"), await read("logs.err"));
      console.log("PASS access log on stdout without health checks; error log on stderr; no serious errors");
    } else throw new Error(`Unknown step: ${step}`);
  }
} catch (error) {
  console.error(`FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
}
