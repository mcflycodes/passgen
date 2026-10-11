// Checks the files scripts/test-compose.sh captures from each running recipe.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  checkGenerated,
  checkHardening,
  checkInternalOnly,
  checkPublished,
  checkRedirect,
} from "./lib/compose-checks.ts";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      inspect: { type: "string" },
      networks: { type: "string" },
      network: { type: "string" },
      user: { type: "string" },
      "cap-add": { type: "string", multiple: true },
      expect: { type: "string", multiple: true },
      response: { type: "string" },
      status: { type: "string" },
      location: { type: "string" },
    },
  });
  const [step, ...extra] = positionals;
  if (extra.length > 0) throw new Error("One step per run");
  const json = async (path: string | undefined, option: string) => {
    if (!path) throw new Error(`--${option} required`);
    return JSON.parse(await readFile(path, "utf8"));
  };
  const text = async (path: string | undefined) => {
    if (!path) throw new Error("--response required");
    return readFile(path, "utf8");
  };
  if (step === "hardening") {
    const [inspect] = await json(values.inspect, "inspect");
    if (values.user === undefined) throw new Error("--user required");
    checkHardening(inspect, { user: values.user, capAdd: values["cap-add"] ?? [] });
    console.log(
      `PASS hardening: user ${values.user || "image default (root)"}, read-only root, /tmp tmpfs, ` +
        `no capabilities${values["cap-add"] ? ` except ${values["cap-add"].join(", ")}` : ""}, no-new-privileges`,
    );
  } else if (step === "published") {
    const [inspect] = await json(values.inspect, "inspect");
    checkPublished(inspect, values.expect ?? []);
    console.log(`PASS published ports: ${values.expect?.join(", ") || "none"}`);
  } else if (step === "internal") {
    const [inspect] = await json(values.inspect, "inspect");
    if (!values.network) throw new Error("--network required");
    checkInternalOnly(inspect, await json(values.networks, "networks"), values.network);
    console.log(`PASS attached only to the internal network ${values.network}`);
  } else if (step === "generated") {
    const status = Number(values.status);
    checkGenerated(await text(values.response), status);
    console.log(`PASS proxy-generated ${status} carries all nine headers once and Cache-Control: no-cache`);
  } else if (step === "redirect") {
    if (!values.location) throw new Error("--location required");
    checkRedirect(await text(values.response), values.location);
    console.log(`PASS HTTP 308 redirect to ${values.location} carries all nine headers once`);
  } else throw new Error(`Unknown step: ${step}`);
} catch (error) {
  console.error(`FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
}
