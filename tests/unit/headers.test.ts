import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findHostnames } from "../../scripts/lib/dist-checks.ts";
import {
  CSP_DIRECTIVES,
  HEADER_ONLY_CSP_DIRECTIVES,
  headerCsp,
  metaCsp,
  SECURITY_HEADERS,
} from "../../security/headers.ts";

function parseCsp(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

function header(name: string): string {
  const found = SECURITY_HEADERS.find((h) => h.name === name);
  assert.ok(found, `missing header ${name}`);
  return found.value;
}

describe("Content Security Policy", () => {
  const csp = parseCsp(headerCsp());

  test("sets connect-src 'none', so fetch, XHR, WebSocket and EventSource are refused", () => {
    assert.deepEqual(csp.get("connect-src"), ["'none'"]);
  });

  test("falls back to nothing for anything not listed", () => {
    assert.deepEqual(csp.get("default-src"), ["'none'"]);
  });

  test("allows same-origin scripts and styles only, never inline or eval", () => {
    assert.deepEqual(csp.get("script-src"), ["'self'"]);
    assert.deepEqual(csp.get("style-src"), ["'self'"]);
    for (const [name, sources] of csp) {
      for (const source of sources) {
        assert.doesNotMatch(
          source,
          /unsafe-|nonce-|sha(256|384|512)-|strict-dynamic|^\*$|^data:|^blob:|^https?:/,
          name,
        );
      }
    }
  });

  test("locks down base, forms, plugins, workers and frames", () => {
    for (const name of ["base-uri", "form-action", "object-src", "worker-src", "frame-src", "frame-ancestors"]) {
      assert.deepEqual(csp.get(name), ["'none'"], name);
    }
  });

  test("enforces Trusted Types for script sinks", () => {
    assert.deepEqual(csp.get("require-trusted-types-for"), ["'script'"]);
  });

  test("lists each directive once", () => {
    const names = CSP_DIRECTIVES.map(([name]) => name);
    assert.equal(new Set(names).size, names.length);
  });

  test("the header policy and the Content-Security-Policy header agree", () => {
    assert.equal(header("Content-Security-Policy"), headerCsp());
  });

  test("the meta policy is the header policy minus header-only directives", () => {
    const meta = parseCsp(metaCsp());
    for (const name of HEADER_ONLY_CSP_DIRECTIVES) assert.ok(!meta.has(name), `${name} in meta CSP`);
    for (const [name, sources] of csp) {
      if (!HEADER_ONLY_CSP_DIRECTIVES.has(name)) assert.deepEqual(meta.get(name), sources, name);
    }
  });
});

describe("security headers", () => {
  test("include every header S4 and decision 0005 require", () => {
    for (const name of [
      "Content-Security-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Cross-Origin-Opener-Policy",
      "Cross-Origin-Embedder-Policy",
      "Cross-Origin-Resource-Policy",
    ]) {
      header(name);
    }
  });

  test("HSTS lasts at least a year and has no preload", () => {
    const hsts = header("Strict-Transport-Security");
    const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1]);
    assert.ok(maxAge >= 31536000, hsts);
    assert.doesNotMatch(hsts, /preload/);
  });

  test("no referrer, no framing, no sniffing", () => {
    assert.equal(header("Referrer-Policy"), "no-referrer");
    assert.equal(header("X-Frame-Options"), "DENY");
    assert.equal(header("X-Content-Type-Options"), "nosniff");
  });

  test("Permissions-Policy allows only clipboard-write, and only for this origin", () => {
    const entries = header("Permissions-Policy")
      .split(",")
      .map((e) => e.trim().split("="));
    const allowed = entries.filter(([, allow]) => allow !== "()");
    assert.deepEqual(allowed, [["clipboard-write", "(self)"]]);
    assert.ok(entries.some(([feature]) => feature === "camera"));
  });

  test("contain no hostname, URL or address (0005)", () => {
    for (const h of SECURITY_HEADERS) {
      assert.deepEqual(findHostnames(h.name, `${h.name}: ${h.value}`), []);
    }
  });

  test("values are single-line and safe to quote in server configs", () => {
    for (const h of SECURITY_HEADERS) {
      assert.doesNotMatch(h.value, /["\\\r\n]/, h.name);
      assert.match(h.name, /^[A-Za-z-]+$/);
    }
  });
});
