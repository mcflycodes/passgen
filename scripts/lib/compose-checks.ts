// Checks for the Compose recipe test: what Docker reports about each running
// service, and the responses a proxy or server creates itself.
import assert from "node:assert/strict";
import { checkSecurity, parseResponse } from "./server-probes.ts";

export const HARDENED_TMPFS = "rw,noexec,nosuid,nodev,size=16m,mode=1777";

type Binding = { HostIp?: string; HostPort?: string };
export type ContainerInspect = {
  Config?: { User?: string };
  HostConfig?: {
    ReadonlyRootfs?: boolean;
    CapDrop?: string[] | null;
    CapAdd?: string[] | null;
    SecurityOpt?: string[] | null;
    Tmpfs?: Record<string, string> | null;
    Privileged?: boolean;
    NetworkMode?: string;
    PidMode?: string;
    IpcMode?: string;
  };
  Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean }[];
  NetworkSettings?: {
    Ports?: Record<string, Binding[] | null> | null;
    Networks?: Record<string, { IPAddress?: string }>;
  };
};
export type NetworkInspect = { Name?: string; Internal?: boolean };

/** The hardening flags each recipe sets, as the Docker engine applied them. */
export function checkHardening(inspect: ContainerInspect, expected: { user: string; capAdd: readonly string[] }) {
  const host = inspect.HostConfig ?? {};
  assert.equal(inspect.Config?.User ?? "", expected.user, "Container user");
  assert.equal(host.ReadonlyRootfs, true, "Root filesystem must be read-only");
  assert.deepEqual(host.CapDrop, ["ALL"], "Every capability must be dropped");
  assert.deepEqual(
    (host.CapAdd ?? []).map((cap) => cap.replace(/^CAP_/, "")).sort(),
    [...expected.capAdd].sort(),
    "Only the expected capabilities may be added back",
  );
  assert.ok(
    (host.SecurityOpt ?? []).some((option) => /^no-new-privileges(?:[:=]true)?$/.test(option)),
    "no-new-privileges must be set",
  );
  assert.deepEqual(host.Tmpfs, { "/tmp": HARDENED_TMPFS }, "Only a bounded /tmp tmpfs is writable");
  assert.equal(host.Privileged, false, "Never privileged");
  for (const mode of [host.NetworkMode, host.PidMode, host.IpcMode])
    assert.notEqual(mode, "host", "No host namespaces");
  for (const mount of inspect.Mounts ?? []) {
    assert.doesNotMatch(mount.Source ?? "", /docker\.sock/, "No Docker socket");
    if (mount.Type === "bind") assert.equal(mount.RW, false, `Bind mount ${mount.Destination} must be read-only`);
  }
}

/** Every host binding the engine actually created, as `address:port->port/proto`; `*` is every interface. */
export function publishedPorts(inspect: ContainerInspect): string[] {
  const found = new Set<string>();
  for (const [port, bindings] of Object.entries(inspect.NetworkSettings?.Ports ?? {})) {
    for (const binding of bindings ?? []) {
      const address = ["", "0.0.0.0", "::"].includes(binding.HostIp ?? "") ? "*" : binding.HostIp;
      found.add(`${address}:${binding.HostPort}->${port}`);
    }
  }
  return [...found].sort();
}

export function checkPublished(inspect: ContainerInspect, expected: readonly string[]) {
  assert.deepEqual(publishedPorts(inspect), [...expected].sort(), "Published ports");
}

/** The service is attached only to the named network, and that network has no outside access. */
export function checkInternalOnly(inspect: ContainerInspect, networks: readonly NetworkInspect[], name: string) {
  assert.deepEqual(Object.keys(inspect.NetworkSettings?.Networks ?? {}), [name], "Attached networks");
  const network = networks.find((candidate) => candidate.Name === name);
  assert.ok(network, `Missing network ${name}`);
  assert.equal(network.Internal, true, `${name} must be internal`);
}

/** A response the edge creates itself, such as 502 while PassGen is down. */
export function checkGenerated(raw: string, status: number) {
  checkSecurity(raw, [status], "no-cache");
}

/** The explicit HTTP-to-HTTPS redirect carries the same headers. */
export function checkRedirect(raw: string, location: string) {
  checkSecurity(raw, [308], "no-cache");
  assert.deepEqual(parseResponse(raw).headers.get("location"), [location], "Redirect target");
}
