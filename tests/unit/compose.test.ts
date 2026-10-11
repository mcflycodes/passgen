import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  type ContainerInspect,
  checkGenerated,
  checkHardening,
  checkInternalOnly,
  checkPublished,
  checkRedirect,
  HARDENED_TMPFS,
  publishedPorts,
} from "../../scripts/lib/compose-checks.ts";
import { findHostnames } from "../../scripts/lib/dist-checks.ts";
import { COMPOSE_DOMAIN, COMPOSE_PATHS, renderComposeConfigs } from "../../scripts/lib/site-configs.ts";
import { renderSnippets } from "../../scripts/lib/snippets.ts";
import { SECURITY_HEADERS } from "../../security/headers.ts";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const snippets = renderSnippets();
const configs = renderComposeConfigs(snippets);
const RECIPES = ["caddy-files", "caddy-https", "httpd-files", "localhost"];
const PASSGEN_IMAGE =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a Compose variable, not a template
  "${PASSGEN_IMAGE:?Set PASSGEN_IMAGE to ghcr.io/mcflycodes/passgen:X.Y.Z@sha256:<digest>; see docs/docker.md}";
const CADDY_IMAGE = /^public\.ecr\.aws\/docker\/library\/caddy:\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/;
const HTTPD_IMAGE = /^public\.ecr\.aws\/docker\/library\/httpd:\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/;
const PUBLIC_PORTS = ['"80:80"', '"443:443"', '"443:443/udp"'];

/** Service blocks under `services:`, keyed by name, without a YAML dependency. */
function services(compose: string): Map<string, string> {
  const section = compose.split(/^services:\n/m)[1]?.split(/^\S/m)[0] ?? "";
  return new Map(
    [...section.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\n)*)/gm)].map((match) => [match[1] ?? "", match[2] ?? ""]),
  );
}

function listItems(block: string, key: string): string[] {
  const inline = block.match(new RegExp(`^ {4}${key}: \\[(.*)\\]$`, "m"))?.[1];
  if (inline !== undefined) return inline.split(", ").filter(Boolean);
  const list = block.match(new RegExp(`^ {4}${key}:\\n((?: {6}- .*\\n)+)`, "m"))?.[1] ?? "";
  return [...list.matchAll(/^ {6}- (.*)$/gm)].map((match) => match[1] ?? "");
}

function checkCompose(recipe: string, compose: string) {
  const all = services(compose);
  assert.ok(all.size > 0, `${recipe}: no services`);
  assert.doesNotMatch(
    compose,
    /privileged|network_mode|pid: host|ipc: host|docker\.sock|userns_mode|cap_add: \[(?!NET_BIND_SERVICE\])/,
  );
  for (const [name, block] of all) {
    const where = `${recipe}/${name}`;
    const image = block.match(/^ {4}image: (.+)$/m)?.[1] ?? "";
    if (image.startsWith("${PASSGEN_IMAGE")) assert.equal(image, PASSGEN_IMAGE, where);
    else assert.ok(CADDY_IMAGE.test(image) || HTTPD_IMAGE.test(image), `${where}: pin by version and digest`);
    assert.match(block, /^ {4}read_only: true$/m, `${where}: read-only root`);
    assert.deepEqual(listItems(block, "tmpfs"), [`/tmp:${HARDENED_TMPFS}`], `${where}: bounded /tmp`);
    assert.deepEqual(listItems(block, "cap_drop"), ["ALL"], `${where}: drop every capability`);
    assert.deepEqual(listItems(block, "security_opt"), ['"no-new-privileges:true"'], `${where}: no-new-privileges`);
    assert.match(block, /^ {4}restart: unless-stopped$/m, where);
    const caddy = CADDY_IMAGE.test(image);
    assert.deepEqual(listItems(block, "cap_add"), caddy ? ["NET_BIND_SERVICE"] : [], `${where}: capabilities`);
    const ports = listItems(block, "ports");
    if (caddy) assert.deepEqual(ports, PUBLIC_PORTS, `${where}: Caddy publishes only HTTP and HTTPS`);
    else if (recipe === "caddy-https") assert.deepEqual(ports, [], `${where}: reachable only through Caddy`);
    else assert.deepEqual(ports, ['"127.0.0.1:8080:8080"'], `${where}: loopback only`);
    if (image === PASSGEN_IMAGE) assert.match(block, /^ {4}user: "101:101"$/m, where);
    if (HTTPD_IMAGE.test(image)) {
      assert.match(block, /^ {4}user: "65534:65534"$/m, `${where}: non-root httpd`);
      assert.match(block, /^ {4}command: \["httpd", "-D", "FOREGROUND", "-f", "\/etc\/passgen\/httpd\.conf"\]$/m);
    }
    for (const bind of block.split(/^ {6}- type: /m).slice(1)) {
      assert.match(bind, /^bind\n/, `${where}: only bind mounts use the long syntax`);
      assert.match(bind, /^ {8}read_only: true$/m, `${where}: bind mounts are read-only`);
      assert.match(bind, /^ {10}create_host_path: false$/m, `${where}: a missing folder must fail, not mount empty`);
    }
    for (const volume of listItems(block, "volumes").filter((item) => !item.startsWith("type: ")))
      assert.match(volume, /^caddy_(data|config):\/(data|config)$/, `${where}: only Caddy state is writable`);
  }
}

describe("Compose recipes", () => {
  test("deploy/compose holds exactly the four documented recipes", () => {
    assert.deepEqual(
      readdirSync(new URL("../../deploy/compose/", import.meta.url), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
      RECIPES,
    );
  });

  for (const recipe of RECIPES) {
    const compose = read(`deploy/compose/${recipe}/compose.yaml`);
    test(`${recipe}: pinned images, hardening and loopback or proxy-only exposure`, () => {
      checkCompose(recipe, compose);
    });

    test(`${recipe}: example.env sets exactly the variables compose.yaml requires`, () => {
      const required = [...compose.matchAll(/\$\{(\w+):\?/g)].map((match) => match[1]).sort();
      const example =
        recipe === "httpd-files"
          ? ""
          : read(`deploy/compose/${recipe}/example.env`)
              .split("\n")
              .filter((line) => line && !line.startsWith("#"))
              .join("\n");
      assert.deepEqual([...example.matchAll(/^(\w+)=/gm)].map((match) => match[1]).sort(), [...new Set(required)]);
      assert.doesNotMatch(
        example,
        /=(?!ghcr\.io\/mcflycodes\/passgen:X\.Y\.Z@sha256:<digest>$|passgen\.example\.com$)/m,
      );
    });
  }

  test("every Caddy service uses the same pinned image", () => {
    const images = RECIPES.flatMap((recipe) =>
      [...read(`deploy/compose/${recipe}/compose.yaml`).matchAll(/^ {4}image: (\S*caddy\S*)$/gm)].map((m) => m[1]),
    );
    assert.equal(images.length, 2);
    assert.equal(new Set(images).size, 1);
  });

  test("guard rejects bare or wildcard ports, unpinned images and missing hardening", () => {
    const localhost = read("deploy/compose/localhost/compose.yaml");
    const proxy = read("deploy/compose/caddy-https/compose.yaml");
    const files = read("deploy/compose/httpd-files/compose.yaml");
    for (const [recipe, compose, broken] of [
      ["localhost", localhost, localhost.replace('"127.0.0.1:8080:8080"', '"8080:8080"')],
      ["localhost", localhost, localhost.replace('"127.0.0.1:8080:8080"', '"0.0.0.0:8080:8080"')],
      ["localhost", localhost, localhost.replace("    read_only: true\n", "")],
      ["localhost", localhost, localhost.replace("    cap_drop: [ALL]\n", "")],
      ["localhost", localhost, localhost.replace('"no-new-privileges:true"', '"no-new-privileges:false"')],
      ["localhost", localhost, localhost.replace("size=16m,", "")],
      ["localhost", localhost, localhost.replace('    user: "101:101"\n', "")],
      ["caddy-https", proxy, proxy.replace("    networks: [backend]\n", '    ports: ["8080:8080"]\n')],
      ["caddy-https", proxy, proxy.replace(/@sha256:[a-f0-9]{64}/, "")],
      ["caddy-https", proxy, proxy.replace("caddy:2.11.7@", "caddy:2@")],
      ["caddy-https", proxy, proxy.replace("cap_add: [NET_BIND_SERVICE]", "cap_add: [SYS_ADMIN]")],
      [
        "caddy-https",
        proxy,
        proxy.replace("restart: unless-stopped\n", "restart: unless-stopped\n    privileged: true\n"),
      ],
      ["httpd-files", files, files.replace("          create_host_path: false\n", "")],
      ["httpd-files", files, files.replace("        read_only: true\n", "")],
      ["httpd-files", files, files.replace('user: "65534:65534"', 'user: "0:0"')],
      ["httpd-files", files, files.replace('"-f", "/etc/passgen/httpd.conf"', '"-f", "conf/httpd.conf"')],
    ] as const) {
      assert.notEqual(broken, compose);
      assert.throws(() => checkCompose(recipe, broken), recipe);
    }
  });

  test("recipes and their configuration name only generic placeholders", () => {
    for (const recipe of RECIPES) {
      const text = [
        `deploy/compose/${recipe}/compose.yaml`,
        ...(recipe === "httpd-files" ? [] : [`deploy/compose/${recipe}/example.env`]),
      ]
        .map(read)
        .join("\n")
        // Registry and repository names in image references and their guidance.
        .replace(/public\.ecr\.aws\/docker\/library\/(caddy|httpd)/g, "official-image")
        .replace(/@sha256:(?:[a-f0-9]{64}|<[^>]+>)/g, "-digest")
        // Loopback publishing is the generic safe binding; any other address stays scanned.
        .replaceAll("127.0.0.1:8080", "loopback:8080")
        .replaceAll("ghcr.io/mcflycodes/passgen", "passgen-image")
        .replaceAll("docs/docker.md", "guide")
        .replaceAll("compose.yaml", "compose-file")
        .replaceAll("example.env", "example-env");
      assert.deepEqual(
        findHostnames(recipe, text).filter((finding) => finding.problem !== "host name: passgen.example.com"),
        [],
      );
    }
    for (const [file, content] of configs) {
      // Caddy's placeholders stand for the configured name; literal names stay scanned.
      const text = content
        .replaceAll(COMPOSE_PATHS.httpdMain, "/etc/passgen/main")
        .replaceAll("mime.types", "types")
        .replaceAll(`http://${COMPOSE_DOMAIN} {`, "{")
        .replaceAll("https://{host}{uri}", "redirect-target")
        // File names whose extensions are also top-level domains, and httpd's required
        // local ServerName, which no response or redirect uses (UseCanonicalName is off).
        .replace(/modules\/mod_\w+\.so/g, "module")
        .replaceAll("/tmp/httpd.pid", "/tmp/pid")
        .replaceAll("ServerName localhost\n", "");
      assert.deepEqual(findHostnames(file, text), [], file);
    }
  });
});

describe("Compose recipe configuration", () => {
  const strip = (text: string) =>
    text
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n");

  test("the committed files match the generator", () => {
    for (const [file, content] of configs)
      assert.equal(read(`deploy/compose/${file}`), content, "run `pnpm headers:gen`");
  });

  test("header snippets are the shipped snippets, byte for byte", () => {
    assert.equal(configs.get("caddy-https/caddy/passgen-headers.caddy"), snippets.get("caddy/passgen-headers.caddy"));
    assert.equal(configs.get("caddy-files/caddy/passgen-headers.caddy"), snippets.get("caddy/passgen-headers.caddy"));
    assert.equal(configs.get("httpd-files/httpd/passgen-headers.conf"), snippets.get("apache/passgen-headers.conf"));
  });

  test("Caddy proxy leaves upstream headers alone and adds the snippet only to its own responses", () => {
    const caddyfile = strip(configs.get("caddy-https/caddy/Caddyfile") ?? "");
    const [site = "", redirect = ""] = caddyfile.split(`\nhttp://${COMPOSE_DOMAIN} {`);
    const errors = site.split("\thandle_errors {")[1] ?? "";
    const outside = site.split("\thandle_errors {")[0] ?? "";
    assert.match(outside, /^\{\$PASSGEN_DOMAIN\} \{\n\treverse_proxy passgen:8080\n$/);
    assert.doesNotMatch(caddyfile, /header_down|header_up|\bencode\b|\bintercept\b|handle_response/);
    for (const block of [errors, redirect]) {
      assert.match(block, new RegExp(`\\timport ${COMPOSE_PATHS.caddyHeaders}\\n`));
      assert.match(block, /\theader Cache-Control "no-cache"\n/);
    }
    assert.match(errors, /respond "PassGen is unavailable" \{err\.status_code\}/);
    assert.match(redirect, /\tredir https:\/\/\{host\}\{uri\} 308\n/);
    for (const { name } of SECURITY_HEADERS) assert.doesNotMatch(caddyfile, new RegExp(`\\b${name}\\b`, "i"));
  });

  test("Caddy files recipe is the shipped Caddyfile with only address, tls, import path and redirect changed", () => {
    const compose = configs.get("caddy-files/caddy/Caddyfile") ?? "";
    const [site = "", redirect] = strip(compose).split(`\nhttp://${COMPOSE_DOMAIN} {`);
    assert.ok(redirect, "explicit redirect with headers");
    const shipped = strip(snippets.get("caddy/Caddyfile") ?? "")
      .replace("example.com {", `${COMPOSE_DOMAIN} {`)
      .replace(/^\ttls .*\n/m, "")
      .replaceAll("/etc/caddy/passgen/passgen-headers.caddy", COMPOSE_PATHS.caddyHeaders);
    assert.equal(`${site}\n`, shipped);
  });

  test("httpd site is the shipped vhost with only listener, TLS, host check and include path changed", () => {
    const compose = configs.get("httpd-files/httpd/passgen-site.conf") ?? "";
    const shipped = strip(snippets.get("apache/passgen-site.conf") ?? "")
      .replace("<VirtualHost *:443>", "<VirtualHost *:8080>")
      .replace(/^ {4}(ServerName|SSLEngine|SSLCertificateFile|SSLCertificateKeyFile) .*\n/gm, "")
      .replace(/^ {12}Require expr "%\{HTTP_HOST\}.*\n/m, "")
      .replace("/etc/httpd/passgen/passgen-headers.conf", COMPOSE_PATHS.httpdHeaders);
    assert.equal(strip(compose), shipped);
    assert.match(compose, /^ {12}Require method GET HEAD$/m);
    assert.match(compose, /^ {4}FileETag None$/m);
  });

  test("httpd main configuration loads only what the site needs and writes only /tmp", () => {
    const main = configs.get("httpd-files/httpd/httpd.conf") ?? "";
    assert.deepEqual(
      [...main.matchAll(/^LoadModule (\w+) /gm)].map((match) => match[1]),
      [
        "mpm_event_module",
        "unixd_module",
        "authz_core_module",
        "reqtimeout_module",
        "mime_module",
        "log_config_module",
        "headers_module",
        "dir_module",
      ],
    );
    for (const line of [
      "Listen 8080",
      "PidFile /tmp/httpd.pid",
      "DefaultRuntimeDir /tmp",
      "ServerTokens Prod",
      "ErrorLog /proc/self/fd/2",
      `Include ${COMPOSE_PATHS.httpdSite}`,
    ])
      assert.match(main, new RegExp(`^${line.replaceAll(".", "\\.").replaceAll("/", "\\/")}$`, "m"), line);
    assert.doesNotMatch(
      main,
      /^(User|Group|Alias|ScriptAlias|LoadModule \w*(proxy|cgi|autoindex|status|info|rewrite|ssl))/m,
    );
  });
});

const hardened: ContainerInspect = {
  Config: { User: "101:101" },
  HostConfig: {
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    CapAdd: null,
    SecurityOpt: ["no-new-privileges:true"],
    Tmpfs: { "/tmp": HARDENED_TMPFS },
    Privileged: false,
    NetworkMode: "passgen_backend",
  },
  Mounts: [{ Type: "bind", Source: "/srv/compose/passgen", Destination: "/srv/passgen", RW: false }],
  NetworkSettings: {
    Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] },
    Networks: { passgen_backend: { IPAddress: "172.18.0.2" } },
  },
};
const withHost = (change: Partial<NonNullable<ContainerInspect["HostConfig"]>>): ContainerInspect => ({
  ...hardened,
  HostConfig: { ...hardened.HostConfig, ...change },
});

function response(status: number, extra: string[] = [], skip?: string): string {
  const headers = SECURITY_HEADERS.filter((h) => h.name !== skip).map((h) => `${h.name}: ${h.value}`);
  return [`HTTP/1.1 ${status} Status`, ...headers, "Cache-Control: no-cache", ...extra, "", ""].join("\r\n");
}

describe("Compose runtime checks", () => {
  test("hardening accepts the recipe flags and Docker's CAP_ spelling", () => {
    checkHardening(hardened, { user: "101:101", capAdd: [] });
    checkHardening(withHost({ CapAdd: ["CAP_NET_BIND_SERVICE"] }), { user: "101:101", capAdd: ["NET_BIND_SERVICE"] });
  });

  test("hardening rejects each missing flag", () => {
    for (const broken of [
      withHost({ ReadonlyRootfs: false }),
      withHost({ CapDrop: [] }),
      withHost({ CapAdd: ["SYS_ADMIN"] }),
      withHost({ SecurityOpt: [] }),
      withHost({ Tmpfs: { "/tmp": "rw,size=16m" } }),
      withHost({ Tmpfs: { "/tmp": HARDENED_TMPFS, "/run": "rw" } }),
      withHost({ Privileged: true }),
      withHost({ NetworkMode: "host" }),
      withHost({ PidMode: "host" }),
      { ...hardened, Config: { User: "0:0" } },
      { ...hardened, Mounts: [{ Type: "bind", Source: "/var/run/docker.sock", Destination: "/s", RW: false }] },
      {
        ...hardened,
        Mounts: [{ Type: "bind", Source: "/srv/compose/passgen", Destination: "/srv/passgen", RW: true }],
      },
    ])
      assert.throws(() => checkHardening(broken, { user: "101:101", capAdd: [] }));
  });

  test("published ports report every interface as * and reject anything beyond loopback", () => {
    checkPublished(hardened, ["127.0.0.1:8080->8080/tcp"]);
    const everywhere: ContainerInspect = {
      NetworkSettings: {
        Ports: {
          "80/tcp": [
            { HostIp: "0.0.0.0", HostPort: "80" },
            { HostIp: "::", HostPort: "80" },
          ],
          "2019/tcp": null,
        },
      },
    };
    assert.deepEqual(publishedPorts(everywhere), ["*:80->80/tcp"]);
    assert.deepEqual(publishedPorts({ NetworkSettings: { Ports: { "8080/tcp": null } } }), []);
    assert.throws(() => checkPublished(everywhere, ["127.0.0.1:80->80/tcp"]));
    assert.throws(() => checkPublished(hardened, []));
  });

  test("internal-only check needs one attached network with Internal set", () => {
    const networks = [
      { Name: "passgen_backend", Internal: true },
      { Name: "passgen_edge", Internal: false },
    ];
    checkInternalOnly(hardened, networks, "passgen_backend");
    assert.throws(() => checkInternalOnly(hardened, [{ Name: "passgen_backend", Internal: false }], "passgen_backend"));
    assert.throws(() =>
      checkInternalOnly(
        { NetworkSettings: { Networks: { passgen_backend: {}, passgen_edge: {} } } },
        networks,
        "passgen_backend",
      ),
    );
  });

  test("generated responses and redirects need all nine headers once", () => {
    checkGenerated(response(502), 502);
    checkRedirect(response(308, ["Location: https://passgen.localhost/"]), "https://passgen.localhost/");
    assert.throws(() => checkGenerated(response(502, [], "Content-Security-Policy"), 502));
    assert.throws(() => checkGenerated(response(502, ["X-Frame-Options: DENY"]), 502));
    assert.throws(() => checkGenerated(response(503), 502));
    assert.throws(() =>
      checkRedirect(response(301, ["Location: https://passgen.localhost/"]), "https://passgen.localhost/"),
    );
    assert.throws(() =>
      checkRedirect(response(308, ["Location: http://passgen.localhost/"]), "https://passgen.localhost/"),
    );
  });
});
