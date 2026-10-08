// The one definition of PassGen's security headers (decision 0005, requirement S4).
//
// Everything else is generated from this file:
// - the Content-Security-Policy <meta> tag injected into the built page (vite.config.ts);
// - the reference server snippets in deploy/examples/ (scripts/gen-headers.ts);
// - the headers applied by the local static server used in tests (scripts/lib/static-server.ts).
//
// Rules: no hostname or scheme anywhere in this file. Sources are keywords such as
// 'self' and 'none', so the same policy works at any domain or subpath.
// Changes here are high-risk under S8 and need a security review.

/** CSP directives, in output order. */
export const CSP_DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["default-src", ["'none'"]],
  ["script-src", ["'self'"]],
  ["style-src", ["'self'"]],
  ["img-src", ["'self'"]],
  ["font-src", ["'self'"]],
  ["manifest-src", ["'self'"]],
  ["connect-src", ["'none'"]],
  ["object-src", ["'none'"]],
  ["worker-src", ["'none'"]],
  ["frame-src", ["'none'"]],
  ["child-src", ["'none'"]],
  ["media-src", ["'none'"]],
  ["base-uri", ["'none'"]],
  ["form-action", ["'none'"]],
  ["frame-ancestors", ["'none'"]],
  ["require-trusted-types-for", ["'script'"]],
  ["trusted-types", ["'none'"]],
];

/**
 * Directives a browser ignores when the policy is delivered in a <meta> tag.
 * They only work as an HTTP header, so they are left out of the meta CSP.
 */
export const HEADER_ONLY_CSP_DIRECTIVES: ReadonlySet<string> = new Set(["frame-ancestors", "report-uri", "sandbox"]);

function serializeCsp(directives: ReadonlyArray<readonly [string, readonly string[]]>): string {
  return directives.map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
}

/** The CSP for the HTTP header: every directive. */
export function headerCsp(): string {
  return serializeCsp(CSP_DIRECTIVES);
}

/** The CSP for the <meta http-equiv> tag: every directive a meta policy honours. */
export function metaCsp(): string {
  return serializeCsp(CSP_DIRECTIVES.filter(([name]) => !HEADER_ONLY_CSP_DIRECTIVES.has(name)));
}

/** Browser features the page never uses are switched off; only copy-to-clipboard is allowed. */
export const PERMISSIONS_POLICY: ReadonlyArray<readonly [string, string]> = [
  ["accelerometer", "()"],
  ["autoplay", "()"],
  ["camera", "()"],
  ["clipboard-read", "()"],
  ["clipboard-write", "(self)"],
  ["display-capture", "()"],
  ["encrypted-media", "()"],
  ["fullscreen", "()"],
  ["geolocation", "()"],
  ["gyroscope", "()"],
  ["magnetometer", "()"],
  ["microphone", "()"],
  ["midi", "()"],
  ["payment", "()"],
  ["picture-in-picture", "()"],
  ["publickey-credentials-get", "()"],
  ["screen-wake-lock", "()"],
  ["usb", "()"],
  ["xr-spatial-tracking", "()"],
];

export interface SecurityHeader {
  readonly name: string;
  readonly value: string;
  /** Why the header is there; written into the generated snippets as a comment. */
  readonly purpose: string;
}

/**
 * Headers every response must carry, including 404s.
 * HSTS has no `preload`: preloading is a decision for each deployer's whole domain.
 */
export const SECURITY_HEADERS: readonly SecurityHeader[] = [
  {
    name: "Content-Security-Policy",
    value: headerCsp(),
    purpose: "Same-origin code only, no inline script, no network requests (S4).",
  },
  {
    name: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
    purpose: "HTTPS only for two years (T6). Ignored by browsers over plain HTTP.",
  },
  {
    name: "X-Content-Type-Options",
    value: "nosniff",
    purpose: "Files are only run as the type the server declares.",
  },
  {
    name: "X-Frame-Options",
    value: "DENY",
    purpose: "No framing, for browsers that ignore CSP frame-ancestors (T7).",
  },
  {
    name: "Referrer-Policy",
    value: "no-referrer",
    purpose: "Never send this page's URL to anyone.",
  },
  {
    name: "Permissions-Policy",
    value: PERMISSIONS_POLICY.map(([feature, allow]) => `${feature}=${allow}`).join(", "),
    purpose: "Switch off every browser feature except writing to the clipboard.",
  },
  {
    name: "Cross-Origin-Opener-Policy",
    value: "same-origin",
    purpose: "Other sites' windows get no handle on this page.",
  },
  {
    name: "Cross-Origin-Embedder-Policy",
    value: "require-corp",
    purpose: "Only resources that opt in can load, isolating the page.",
  },
  {
    name: "Cross-Origin-Resource-Policy",
    value: "same-origin",
    purpose: "Other sites cannot embed this site's files.",
  },
];
