import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  checkImageConfig,
  checkLogs,
  checkProcesses,
  checkResponses,
  ENTRYPOINT,
  IMAGE_SOURCE,
} from "../../scripts/lib/container-checks.ts";
import { CONTAINER_PATHS, renderContainerConfigs } from "../../scripts/lib/site-configs.ts";
import { renderSnippets } from "../../scripts/lib/snippets.ts";
import { SECURITY_HEADERS } from "../../security/headers.ts";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const dockerfile = read("Dockerfile");
const container = renderContainerConfigs();
const site = container.get("passgen-site.conf") ?? "";
const main = container.get("nginx.conf") ?? "";
const example = renderSnippets().get("nginx/passgen-site.conf") ?? "";
const code = (text: string) => text.replace(/^\s*#.*$/gm, "");

function instructions(text: string): string[] {
  return text
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"));
}

function checkDockerfile(text: string) {
  const lines = instructions(text);
  const from = lines.filter((line) => line.startsWith("FROM "));
  assert.equal(from.length, 2, "One pinned upstream stage and one final stage");
  assert.match(
    from[0] ?? "",
    /^FROM public\.ecr\.aws\/nginx\/nginx-unprivileged:\d+\.\d+\.\d+-alpine-slim@sha256:[a-f0-9]{64} AS upstream$/,
    "Base must be nginx's unprivileged slim image pinned by version and index digest",
  );
  assert.equal(from[1], "FROM upstream");
  assert.ok(!lines.some((line) => /^(RUN|ADD|ONBUILD|VOLUME|SHELL)\b/.test(line)), "Files only: no RUN, ADD or VOLUME");
  assert.doesNotMatch(text, /^# syntax=/m, "No frontend image pulled from Docker Hub");
  assert.deepEqual(
    lines.filter((line) => line.startsWith("COPY ")),
    [
      `COPY --from=upstream --chown=0:0 --chmod=0644 /etc/nginx/mime.types ${CONTAINER_PATHS.mimeTypes}`,
      `COPY --chown=0:0 --chmod=0644 deploy/container/nginx.conf deploy/container/passgen-site.conf ${CONTAINER_PATHS.config}/`,
      `COPY --chown=0:0 --chmod=0644 deploy/examples/nginx/passgen-headers.conf ${CONTAINER_PATHS.headers}`,
      `COPY --chown=0:0 dist/ ${CONTAINER_PATHS.root}/`,
    ],
    "The image must use the generated header snippet and configuration unchanged",
  );
  assert.ok(lines.includes("USER 101:101"));
  assert.ok(lines.includes(`EXPOSE ${CONTAINER_PATHS.port}`));
  assert.ok(lines.includes(`ENTRYPOINT ${JSON.stringify(ENTRYPOINT).replaceAll(",", ", ")}`));
  assert.ok(lines.includes("CMD []"));
  const health = lines.find((line) => line.startsWith("HEALTHCHECK "));
  assert.match(health ?? "", / CMD \["wget", .*"http:\/\/127\.0\.0\.1:8080\/index\.html"\]$/);
  assert.match(health ?? "", /"-U", "passgen-healthcheck"/);
  const labels = lines.find((line) => line.startsWith("LABEL ")) ?? "";
  for (const [name, value] of [
    ["org.opencontainers.image.source", IMAGE_SOURCE],
    ["org.opencontainers.image.licenses", "Apache-2.0"],
    ["org.opencontainers.image.version", `\${PASSGEN_VERSION}`],
    ["org.opencontainers.image.revision", `\${PASSGEN_REVISION}`],
    ["org.opencontainers.image.created", `\${PASSGEN_CREATED}`],
    ["org.opencontainers.image.title", "PassGen"],
    ["org.opencontainers.image.url", IMAGE_SOURCE],
    ["maintainer", ""],
  ])
    assert.ok(labels.includes(` ${name}="${value}"`), name);
}

describe("official container image", () => {
  test("Dockerfile pins the base, adds files only and runs non-root nginx directly", () => {
    checkDockerfile(dockerfile);
  });

  test("Dockerfile guard rejects unpinned bases, RUN steps, other header sources and root", () => {
    for (const broken of [
      dockerfile.replace(/@sha256:[a-f0-9]{64}/, ""),
      dockerfile.replace("public.ecr.aws/nginx/nginx-unprivileged:", "public.ecr.aws/nginx/nginx:"),
      dockerfile.replace("-alpine-slim@", "-alpine@"),
      dockerfile.replace("USER 101:101", "USER 101:101\nRUN rm -rf /etc/nginx/conf.d"),
      dockerfile.replace("deploy/examples/nginx/passgen-headers.conf", "container/headers.conf"),
      dockerfile.replace("USER 101:101", "USER root"),
      dockerfile.replace('ENTRYPOINT ["nginx"', 'ENTRYPOINT ["/docker-entrypoint.sh", "nginx"'),
      dockerfile.replace('"-U", "passgen-healthcheck", ', ""),
      dockerfile.replace(/ +org\.opencontainers\.image\.revision="\$\{PASSGEN_REVISION\}" \\\n/, ""),
      `# syntax=docker/dockerfile:1\n${dockerfile}`,
    ]) {
      assert.notEqual(broken, dockerfile);
      assert.throws(() => checkDockerfile(broken));
    }
  });

  test(".dockerignore sends only the build and its generated configuration", () => {
    assert.deepEqual(
      read(".dockerignore")
        .split("\n")
        .filter((line) => line && !line.startsWith("#")),
      ["*", "!dist", "!deploy/container", "!deploy/examples/nginx/passgen-headers.conf"],
    );
  });

  test("container site config is the shipped nginx example with only listener, transport and include path changed", () => {
    const normalise = (text: string, headers: string) =>
      text
        .split("\n")
        .slice(1)
        .filter((line) => !line.startsWith("# "))
        .filter(
          (line) => !/^ {4}(listen|server_name|ssl_certificate|ssl_certificate_key|absolute_redirect) /.test(line),
        )
        .join("\n")
        .replaceAll(headers, "HEADERS");
    assert.equal(
      normalise(site, CONTAINER_PATHS.headers),
      normalise(example, "/etc/nginx/passgen/passgen-headers.conf"),
    );
  });

  test("container headers come only from the generated snippet, in every add_header block", () => {
    for (const config of [site, main]) {
      for (const { name } of SECURITY_HEADERS) assert.doesNotMatch(config, new RegExp(`add_header\\s+${name}\\b`, "i"));
    }
    const blocks = site.split(/\n {4}location /);
    assert.equal(blocks.length, 8);
    for (const block of blocks) {
      const own = block.split("\n    }")[0] ?? "";
      assert.ok(own.includes(`include ${CONTAINER_PATHS.headers};`), own.split("\n")[0]);
    }
    assert.equal(
      (site.match(/add_header /g) ?? []).length,
      (site.match(/include \/etc\/passgen\/passgen-headers/g) ?? []).length,
    );
    assert.doesNotMatch(main, /add_header/);
  });

  test("container serves plain HTTP on 8080 for any host and never redirects on the scheme", () => {
    assert.match(site, /^ {4}listen 8080 default_server;$/m);
    assert.match(site, /^ {4}server_name _;$/m);
    assert.match(site, /^ {4}absolute_redirect off;$/m);
    assert.doesNotMatch(
      code(`${site}${main}`),
      /\bssl\b|\$scheme|\$https|return 30[1278]|https:\/\/|rewrite |proxy_pass|fastcgi_pass/,
    );
    assert.match(site, /server_tokens off;/);
    assert.match(main, /^ {4}server_tokens off;$/m);
  });

  test("nginx main config writes only to /tmp and logs to stdout and stderr", () => {
    assert.match(main, /^daemon off;$/m);
    assert.match(main, /^pid \/tmp\/nginx\.pid;$/m);
    assert.match(main, /^error_log \/dev\/stderr notice;$/m);
    assert.match(main, /^ {4}access_log \/dev\/stdout main if=\$passgen_access_log;$/m);
    for (const kind of ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"])
      assert.match(main, new RegExp(`^ {4}${kind}_temp_path /tmp/\\w+;$`, "m"), kind);
    assert.match(main, new RegExp(`^ {4}include ${CONTAINER_PATHS.mimeTypes};$`, "m"));
    assert.match(main, new RegExp(`^ {4}include ${CONTAINER_PATHS.site};$`, "m"));
    assert.doesNotMatch(main, /^user /m, "The image's USER sets the account");
    for (const path of code(main).matchAll(/(?:^|\s)(\/[\w./-]+)/g)) {
      const file = path[1] ?? "";
      assert.ok(/^\/(?:tmp\/|dev\/std(?:out|err)$|etc\/passgen\/)/.test(file), `Unexpected path ${file}`);
    }
  });
});

const inspect = {
  Os: "linux",
  Architecture: "amd64",
  Config: {
    User: "101:101",
    Entrypoint: ENTRYPOINT,
    Cmd: null,
    ExposedPorts: { "8080/tcp": {} },
    StopSignal: "SIGQUIT",
    Healthcheck: { Test: ["CMD", "wget", "-q", "http://127.0.0.1:8080/index.html"] },
    Labels: {
      maintainer: "",
      "org.opencontainers.image.source": IMAGE_SOURCE,
      "org.opencontainers.image.url": IMAGE_SOURCE,
      "org.opencontainers.image.version": "1.3.1",
      "org.opencontainers.image.revision": "a".repeat(40),
      "org.opencontainers.image.licenses": "Apache-2.0",
      "org.opencontainers.image.title": "PassGen",
      "org.opencontainers.image.created": "2026-10-10T00:00:00Z",
    },
  },
};
const expected = { version: "1.3.1", revision: "a".repeat(40), architecture: "amd64" };

describe("container runtime checks", () => {
  test("image config check accepts the contract and rejects each deviation", () => {
    checkImageConfig(inspect, expected);
    const config = inspect.Config;
    for (const broken of [
      { ...inspect, Architecture: "arm64" },
      { ...inspect, Config: { ...config, User: "101" } },
      { ...inspect, Config: { ...config, User: "0:0" } },
      { ...inspect, Config: { ...config, Entrypoint: ["/docker-entrypoint.sh"] } },
      { ...inspect, Config: { ...config, Cmd: ["nginx", "-g", "daemon off;"] } },
      { ...inspect, Config: { ...config, Healthcheck: { Test: ["CMD-SHELL", "true"] } } },
      { ...inspect, Config: { ...config, Labels: { ...config.Labels, "org.opencontainers.image.version": "1.0.0" } } },
      {
        ...inspect,
        Config: {
          ...config,
          Labels: { ...config.Labels, "org.opencontainers.image.description": "docker-nginx-unprivileged" },
        },
      },
    ])
      assert.throws(() => checkImageConfig(broken, expected));
  });

  const status = (name: string, overrides: Record<string, string> = {}) =>
    Object.entries({
      Name: name,
      Uid: "101\t101\t101\t101",
      Gid: "101\t101\t101\t101",
      CapInh: "0000000000000000",
      CapPrm: "0000000000000000",
      CapEff: "0000000000000000",
      CapBnd: "0000000000000000",
      CapAmb: "0000000000000000",
      NoNewPrivs: "1",
      ...overrides,
    })
      .map(([key, value]) => `${key}:\t${value}`)
      .join("\n");

  test("process check requires master and worker without root, capabilities or privilege gain", () => {
    const shell = status("sh", { Uid: "0\t0\t0\t0" });
    assert.equal(checkProcesses([status("nginx"), status("nginx"), shell].join("\n\n")), 2);
    assert.throws(() => checkProcesses(status("nginx")));
    for (const override of [
      { Uid: "0\t0\t0\t0" },
      { Gid: "101\t101\t101\t0" },
      { CapEff: "00000000a80425fb" },
      { CapBnd: "00000000a80425fb" },
      { NoNewPrivs: "0" },
    ])
      assert.throws(() => checkProcesses([status("nginx"), status("nginx", override)].join("\n\n")));
  });

  const response = (status: number, extra = "") =>
    `HTTP/1.1 ${status} X\r\nServer: nginx\r\n${SECURITY_HEADERS.map(({ name, value }) => `${name}: ${value}\r\n`).join("")}Cache-Control: no-cache\r\n${extra}\r\n`;

  test("response check requires 405 for POST, any host and a versionless Server header", () => {
    const valid = { post: response(405), otherHost: response(200), root: response(200) };
    checkResponses(valid);
    for (const broken of [
      { ...valid, post: response(403) },
      { ...valid, otherHost: response(404) },
      { ...valid, root: response(200).replace("Server: nginx", "Server: nginx/1.30.5") },
      { ...valid, root: response(200, "Location: https://example.com/\r\n") },
      { ...valid, post: response(405).replace("X-Frame-Options: DENY\r\n", "") },
    ])
      assert.throws(() => checkResponses(broken));
  });

  test("log check requires stdout access logs without health checks and stderr errors only", () => {
    const out =
      '1.2.3.4 - - [x] "GET / HTTP/1.1" 200 1 "-" "curl" "-"\n1.2.3.4 - - [x] "POST / HTTP/1.1" 405 1 "-" "curl" "-"\n';
    const err = "2026/10/10 00:00:00 [notice] 1#1: start worker processes\n";
    checkLogs(out, err);
    for (const [badOut, badErr] of [
      ["", err],
      [`${out}127.0.0.1 - - [x] "GET /index.html HTTP/1.1" 200 1 "-" "passgen-healthcheck" "-"\n`, err],
      [out, ""],
      [out, `${err}${out}`],
      [out, `${err}2026/10/10 00:00:00 [emerg] 1#1: bind() failed\n`],
    ])
      assert.throws(() => checkLogs(badOut ?? "", badErr ?? ""));
  });
});
