import assert from "node:assert/strict";
import { test } from "node:test";
import { EXAMPLE_TOOLS } from "../../scripts/lib/attribution-patterns.ts";
import { scanText } from "../../scripts/lib/attribution-scan.ts";
import { findInternalHostnames } from "../../scripts/lib/dist-checks.ts";

for (const text of [
  "openssl s_client -connect srv42:443",
  "$ proxy --upstream srv42:443",
  "~~~sh\nthe proxy at srv42:443\n~~~",
  "```sh\nthe proxy at srv42:443\n```",
  "Use `openssl s_client -connect srv42:443` first",
  "~~~sh\nthe proxies at srv42:443 and nas:8080\n~~~",
]) {
  test(`mid-line host ports: ${text}`, () => {
    const hosts = ["srv42", ...(text.includes("nas:") ? ["nas"] : [])];
    assert.deepEqual(
      findInternalHostnames("fixture", text).map((finding) => finding.problem),
      hosts.map((host) => `single-label host name: ${host}`),
    );
  });
}
for (const text of ["the proxy at srv42:443", "Length:20", "Entropy:128", "const time = 07:00;"]) {
  test(`ports outside command contexts: ${text}`, () => {
    assert.deepEqual(findInternalHostnames("fixture", text), []);
  });
}
for (const text of [
  "ssh into the box",
  "ssh to it",
  "Use ssh -v for debugging",
  "(ping the box)",
  ...[
    "into",
    "to",
    "for",
    "the",
    "a",
    "an",
    "it",
    "over",
    "via",
    "with",
    "from",
    "on",
    "in",
    "at",
    "and",
    "or",
    "of",
    "is",
    "are",
    "as",
  ].map((word) => `ssh ${word} the box`),
  "ssh THE box",
  "Use `ssh into the box` first",
  "~~~sh\nssh to it\n~~~",
]) {
  test(`command stopwords: ${text}`, () => {
    assert.deepEqual(findInternalHostnames("fixture", text), []);
  });
}
for (const text of [
  "ssh user@srv42",
  "ssh srv42,",
  "_ssh srv42_",
  "ssh srv42|",
  "Use ssh srv42, then continue",
  "Use _ssh srv42_ first",
  "Use ssh srv42|cat",
  "Use `ssh srv42,` first",
  "ssh -v srv42,",
  "ping srv42,",
]) {
  test(`punctuated command targets: ${text}`, () => {
    assert.deepEqual(findInternalHostnames("fixture", text), [
      { file: "fixture", problem: "single-label host name: srv42" },
    ]);
  });
}
const pointerTool = EXAMPLE_TOOLS.find((name) => name.toLowerCase() === "cursor") as string;
const numberTool = EXAMPLE_TOOLS.find((name) => name.toLowerCase() === "pi") as string;
for (const identifier of [
  `${pointerTool.toLowerCase()}CreatedAt`,
  `${pointerTool.toLowerCase()}MadeVisible`,
  `${numberTool.toLowerCase()}Developed`,
]) {
  test(`tool-first verb boundaries allow ${identifier}`, () => {
    assert.deepEqual(scanText("fixture", `const ${identifier} = true;`), []);
  });
}
for (const identifier of [
  `${pointerTool.toLowerCase()}Generated`,
  `${pointerTool.toUpperCase()}_GENERATED`,
  `${numberTool.toLowerCase()}_Generated`,
]) {
  test(`tool-first credits: ${identifier}`, () => {
    assert.ok(scanText("fixture", `const ${identifier} = true;`).length);
  });
}
for (const text of ["Sign in with @me", "Sign in with @me\nNext line", "x = a//b", "x = a//b\n"]) {
  test(`ordinary mention and double slash: ${text}`, () => {
    assert.deepEqual(findInternalHostnames("fixture", text), []);
  });
}
for (const text of ["@vaultbox", "user@vaultbox", "http://vaultbox", "//vaultbox", "x = //vaultbox/path"]) {
  test(`structured host contexts remain checked: ${text}`, () => {
    assert.deepEqual(findInternalHostnames("fixture", text), [
      { file: "fixture", problem: "single-label host name: vaultbox" },
    ]);
  });
}

for (const text of [
  "Use SSH keys, not passwords.",
  "SSH access, then a reload.",
  "ping times, in ms",
  "dig output, if any",
  "ssh config, then restart",
  "with ssh enabled, the",
  "SSH works, so",
  "Use SSH keys| or passwords",
  "Use ssh service, then continue",
  "Use ssh service|cat",
  "Use _ssh service_ first",
]) {
  test(`review prose stays clean: ${text}`, () => {
    assert.deepEqual(findInternalHostnames("fixture", text), []);
  });
}
for (const text of [
  "Use ssh nas-1, then continue",
  "Use _ssh nas-1_ first",
  "Use ssh nas-1|cat",
  "$ ssh nas,",

  "$ _ssh nas_",
  "$ ssh nas|",
]) {
  test(`review punctuation preserves hosts: ${text}`, () => {
    const host = text.includes("nas-1") ? "nas-1" : "nas";
    assert.deepEqual(findInternalHostnames("fixture", text), [
      { file: "fixture", problem: `single-label host name: ${host}` },
    ]);
  });
}
const coordinatorTool = EXAMPLE_TOOLS.find((name) => name.toLowerCase() === "polly") as string;
for (const tool of [pointerTool, coordinatorTool]) {
  for (const verb of ["built", "created", "generated", "made"]) {
    for (const identifier of [
      `${tool.toLowerCase()}_${verb}`,
      `${tool.toUpperCase()}_${verb.toUpperCase()}`,
      `${tool.toLowerCase()}-${verb}`,
      `${tool.toLowerCase()}${verb[0]?.toUpperCase()}${verb.slice(1)}`,
      `${tool.toUpperCase()}${verb.toUpperCase()}`,
    ]) {
      test(`review credit case styles: ${identifier}`, () => {
        assert.ok(scanText("fixture", `const ${identifier} = true;`).length);
      });
    }
  }
}
for (const identifier of [
  `${pointerTool.toLowerCase()}_createdAt`,
  `${pointerTool.toUpperCase()}_MADEVISIBLE`,
  `${coordinatorTool.toLowerCase()}CreatedAt`,
  `${numberTool.toLowerCase()}Developed`,
]) {
  test(`review verb prefixes stay ordinary: ${identifier}`, () => {
    assert.deepEqual(scanText("fixture", `const ${identifier} = true;`), []);
  });
}
for (const key of [
  "port",
  "timeout",
  "retries",
  "workers",
  "max",
  "min",
  "size",
  "limit",
  "length",
  "entropy",
  "width",
  "height",
  "delay",
  "interval",
  "duration",
  "count",
  "threads",
  "attempts",
  "connections",
  "backlog",
  "buffer",
  "offset",
]) {
  for (const text of [
    `~~~yaml\n${key}:4173\n~~~`,
    `~~~json\n{ "${key}":30 }\n~~~`,
    `~~~config\n${key.toUpperCase()}:30\n~~~`,
    `Use \`${key}:30\` in the configuration`,
  ]) {
    test(`review config values stay clean: ${text}`, () => {
      assert.deepEqual(findInternalHostnames("fixture", text), []);
    });
  }
  for (const text of [`http://${key}:4173`, `ssh user@${key}:4173`]) {
    test(`review explicit config-key hosts still hit: ${text}`, () => {
      assert.deepEqual(findInternalHostnames("fixture", text), [
        { file: "fixture", problem: `single-label host name: ${key}` },
      ]);
    });
  }
}
