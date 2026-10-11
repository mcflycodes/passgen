// Assertions over what scripts/test-container.sh captures from the running image.
import assert from "node:assert/strict";
import { checkSecurity, parseResponse } from "./server-probes.ts";
import { CONTAINER_PATHS } from "./site-configs.ts";

export const IMAGE_SOURCE = "https://github.com/mcflycodes/passgen";
export const RUNTIME_USER = "101:101";
export const ENTRYPOINT = ["nginx", "-c", `${CONTAINER_PATHS.config}/nginx.conf`];

type ImageInspect = {
  Os?: string;
  Architecture?: string;
  Config?: {
    User?: string;
    Entrypoint?: string[] | null;
    Cmd?: string[] | null;
    ExposedPorts?: Record<string, unknown>;
    Healthcheck?: { Test?: string[] };
    Labels?: Record<string, string>;
    StopSignal?: string;
  };
};

export function checkImageConfig(
  inspect: ImageInspect,
  expected: { version: string; revision: string; architecture: string },
) {
  const config = inspect.Config ?? {};
  assert.equal(inspect.Os, "linux");
  assert.equal(inspect.Architecture, expected.architecture, "Image architecture");
  assert.equal(config.User, RUNTIME_USER, "Image must run as UID/GID 101");
  assert.deepEqual(config.Entrypoint, ENTRYPOINT, "nginx must start directly, without the base entrypoint scripts");
  assert.ok(!config.Cmd?.length, "No default arguments");
  assert.deepEqual(Object.keys(config.ExposedPorts ?? {}), [`${CONTAINER_PATHS.port}/tcp`]);
  assert.equal(config.StopSignal, "SIGQUIT");
  const health = config.Healthcheck?.Test ?? [];
  assert.equal(health[0], "CMD", "Health check runs without a shell");
  assert.equal(health[1], "wget", "Health check uses the base image's BusyBox wget");
  assert.equal(health.at(-1), `http://127.0.0.1:${CONTAINER_PATHS.port}/index.html`);
  const labels = config.Labels ?? {};
  assert.deepEqual(
    {
      source: labels["org.opencontainers.image.source"],
      version: labels["org.opencontainers.image.version"],
      revision: labels["org.opencontainers.image.revision"],
      licenses: labels["org.opencontainers.image.licenses"],
      title: labels["org.opencontainers.image.title"],
      url: labels["org.opencontainers.image.url"],
      maintainer: labels.maintainer,
    },
    {
      source: IMAGE_SOURCE,
      version: expected.version,
      revision: expected.revision,
      licenses: "Apache-2.0",
      title: "PassGen",
      url: IMAGE_SOURCE,
      maintainer: "",
    },
  );
  assert.match(labels["org.opencontainers.image.created"] ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  for (const [name, value] of Object.entries(labels)) {
    assert.doesNotMatch(value, /docker-nginx-unprivileged|docker-maint/, `Base image label ${name} must be replaced`);
  }
}

/** `/proc/<pid>/status` files, separated by blank lines, as dumped inside the container. */
export function checkProcesses(dump: string): number {
  const blocks = dump
    .split(/\n\s*\n/)
    .map((block) => new Map(block.split("\n").map((line) => line.split(/:\s*/, 2) as [string, string])))
    .filter((fields) => fields.get("Name") === "nginx");
  assert.ok(blocks.length >= 2, "Expected an nginx master and at least one worker");
  for (const fields of blocks) {
    for (const id of ["Uid", "Gid"])
      assert.deepEqual(fields.get(id)?.split(/\s+/), ["101", "101", "101", "101"], `nginx ${id}`);
    for (const set of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])
      assert.equal(fields.get(set), "0000000000000000", `nginx ${set} must be empty`);
    assert.equal(fields.get("NoNewPrivs"), "1", "nginx must run with no-new-privileges");
  }
  return blocks.length;
}

export function checkResponses(responses: { post: string; otherHost: string; root: string }) {
  checkSecurity(responses.post, [405], "no-cache");
  checkSecurity(responses.otherHost, [200], "no-cache");
  const root = parseResponse(responses.root);
  assert.deepEqual(root.headers.get("server"), ["nginx"], "Server header must not reveal the version");
  for (const name of ["location", "x-powered-by"]) assert.equal(root.headers.get(name), undefined, name);
}

export function checkLogs(stdout: string, stderr: string) {
  assert.match(stdout, /"GET \/ HTTP\/1\.1" 200 /, "Access log must reach stdout");
  assert.match(stdout, /"POST \/ HTTP\/1\.1" 405 /, "Refused requests must be logged");
  assert.doesNotMatch(stdout, /passgen-healthcheck/, "Health checks stay out of the access log");
  assert.doesNotMatch(stderr, /"GET |"POST /, "Access log must not go to stderr");
  assert.match(stderr, /\[notice\].*start worker process/, "Error log must reach stderr");
  assert.doesNotMatch(stderr, /\[(?:emerg|alert|crit)\]/, "nginx reported a serious error");
}
