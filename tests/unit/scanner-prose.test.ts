import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTHORSHIP_VERBS, EXAMPLE_TOOLS } from "../../scripts/lib/attribution-patterns.ts";
import { scanText } from "../../scripts/lib/attribution-scan.ts";
import { findHostnames, findInternalHostnames } from "../../scripts/lib/dist-checks.ts";

// Fresh technical prose, independent of the individual review examples.
const proseCorpus = [
  "SSH sessions should expire when the maintenance window ends.",
  "SSH certificates simplify access for rotating engineering teams.",
  "SSH ed25519 identities are accepted by the current client.",
  "SSH rsa2048 signatures are retained only for compatibility testing.",
  "SSH authentication failures need a timestamp and a correlation identifier.",
  "SSH multiplexing reduces repeated handshakes during a deployment.",
  "SSH connection reuse can conceal an expired credential.",
  "SSH server policy should be reviewed before enabling legacy algorithms.",
  "SSH client diagnostics belong in the support bundle.",
  "SSH agent sockets must remain confined to the active session.",
  "SSH tunnel ownership should be visible to the operator.",
  "SSH login banners should describe the authorized use policy.",
  "SSH key rotation is part of the regular maintenance checklist.",
  "SSH key permissions should be checked before troubleshooting authentication.",
  "SSH password prompts may be unavailable in an unattended job.",
  "SSH control sockets should have a predictable lifetime.",
  "SSH keepalive behavior differs from application health monitoring.",
  "SSH transfers need enough free space on the destination volume.",
  "SSH audit records should identify the initiating account.",
  "SSH encryption protects a session but does not grant authorization.",
  "ssh certificate enrollment depends on the identity workflow.",
  "ssh session logging requires coordination with the support team.",
  "ssh key inventory helps identify credentials without an owner.",
  "ssh agent lifetime should match the maintenance task.",
  "ssh tunnel cleanup belongs in the operator runbook.",
  "ssh client defaults can be overridden by a managed profile.",
  "ssh login policy is separate from application authentication.",
  "ssh server settings require a compatibility review.",
  "ssh authentication retries should be limited to avoid noisy logs.",
  "ssh session metadata is useful when investigating an interrupted transfer.",
  "Ping measurements should include the sampling interval.",
  "Ping p95 measurements are useful for spotting intermittent delays.",
  "Ping payload size can change the observed behavior on a constrained path.",
  "Ping responses are not proof that the application is healthy.",
  "Ping failure may reflect filtering rather than an unavailable service.",
  "Ping sampling needs a consistent clock across the monitoring fleet.",
  "Ping packet loss should be compared with the transport counters.",
  "Ping averages can hide short bursts of congestion.",
  "Ping monitoring should distinguish planned maintenance from an outage.",
  "Ping probes should not exceed the approved monitoring frequency.",
  "ping statistics deserve a larger sample before changing the alert threshold.",
  "ping monitoring runs independently from the transaction checks.",
  "ping payload selection should be documented in the troubleshooting guide.",
  "ping results belong beside the route and interface observations.",
  "ping failures are expected when diagnostic traffic is intentionally filtered.",
  "The operator compared ping samples before and after the queue adjustment.",
  "Collect ping observations while the application load is representative.",
  "Repeated ping measurements help separate jitter from sustained delay.",
  "An isolated ping response does not establish a reliable baseline.",
  "Our dashboard displays ping trends alongside connection errors.",
  "Dig responses should include the resolver used for the query.",
  "Dig cache observations help explain inconsistent lookup results.",
  "Dig validation errors may indicate a clock or trust problem.",
  "Dig diagnostics should preserve the response flags.",
  "Dig output is easier to interpret when the query type is recorded.",
  "Dig recursion behavior depends on the resolver policy.",
  "Dig transport choices can expose differences in middlebox behavior.",
  "Dig query timing should be captured before clearing caches.",
  "Dig examples in training material should use reserved names.",
  "Dig failure codes should be translated into actionable support guidance.",
  "dig response validation belongs in the resolver test plan.",
  "dig query logging should have a defined retention policy.",
  "dig transport diagnostics complement the packet capture.",
  "dig resolver selection can explain a surprising answer.",
  "dig cache behavior should be checked with a controlled test fixture.",
  "Capture dig observations before modifying the resolver settings.",
  "The support team uses dig during name resolution investigations.",
  "Training notes compare dig response sections without naming live systems.",
  "A parser for dig diagnostics should preserve unknown response flags.",
  "The resolver runbook explains when dig is appropriate for a failure.",
  "nc diagnostics require a clearly defined connection timeout.",
  "nc connection testing should be approved for the maintenance window.",
  "nc listener mode is unsuitable for an unattended health probe.",
  "nc transport behavior varies between implementations.",
  "nc process cleanup should happen when the operator closes the session.",
  "nc socket tests complement application level checks.",
  "nc payload generation belongs in an isolated test environment.",
  "nc client behavior should be recorded in the test report.",
  "nc error messages may differ between operating systems.",
  "nc support in the diagnostic image should be checked before travel.",
  "The runbook uses nc for a short connectivity check.",
  "Check the nc implementation before relying on an option.",
  "A successful nc connection only confirms that a listener accepted it.",
  "Operators should collect nc diagnostics without sending production payloads.",
  "The training exercise explains why nc tests need a timeout.",
  "The port setting is read before the listener starts.",
  "The configuration example contains port:4173 for a local preview.",
  "A test fixture uses timeout:30 to avoid a stalled worker.",
  "The retries:3 setting limits repeated work during recovery.",
  "The workers:4 setting controls parallel processing in the example.",
  "The max:10 setting caps the number of queued tasks.",
  "The min:1 setting keeps the sample pool available.",
  "The size:64 setting defines a small bounded buffer.",
  "The limit:20 setting bounds the result count.",
  "The delay:5 setting prevents a tight retry loop.",
  "Configuration keys should be validated before opening a listener.",
  "A missing timeout should select the documented default.",
  "Retry counts should remain bounded during a partial outage.",
  "Worker limits should account for the available memory.",
  "The minimum pool size should not exceed the maximum.",
  "Port allocation should be recorded by the process supervisor.",
  "Timeout values should use a single documented unit.",
  "Configuration validation should explain which field is invalid.",
  "A client can request a smaller page size without changing the server default.",
  "A server can reduce its connection limit while draining traffic.",
  "The interval:60 setting controls the sample schedule.",
  "The duration:15 setting bounds the diagnostic capture.",
  "The threads:2 setting is adequate for the small fixture.",
  "The count:8 setting keeps the example output readable.",
  "The backlog:16 setting keeps the demonstration queue bounded.",
  "The width:80 setting is only a formatting preference.",
  "The height:24 setting describes the terminal fixture.",
  "The buffer:256 setting is measured in the documented units.",
  "The offset:0 setting starts the sample at its first record.",
  "The connections:8 setting is sufficient for the development profile.",
  "A key should have an owner and a documented rotation procedure.",
  "An agent should close unused connections before exiting.",
  "A tunnel should be removed after the maintenance task finishes.",
  "The client should display a useful error when authentication expires.",
  "The login flow should preserve the intended return path.",
  "The server should reject configuration it cannot interpret.",
  "Key material should not appear in a diagnostic report.",
  "Agent configuration is loaded before scheduled work begins.",
  "Tunnel state should be visible in the operator dashboard.",
  "Client logs should include enough context to diagnose a failed handshake.",
  "Login attempts should be correlated without exposing credential values.",
  "Server maintenance should include a check of the active connection count.",
  "An SSH key can be revoked independently from the account password.",
  "An SSH agent should not outlive the session that owns it.",
  "An SSH tunnel needs a clear purpose and an explicit owner.",
  "An SSH client may reuse a connection until its control socket expires.",
  "An SSH login can succeed while the application remains unavailable.",
  "An SSH server should offer only the approved algorithms.",
  "Use ssh documentation to compare the available authentication methods.",
  "Use ping measurements to establish a baseline before investigating jitter.",
  "Use dig diagnostics to identify the resolver that supplied an answer.",
  "Use nc documentation to confirm how the installed implementation handles EOF.",
  "The support bundle contains client logs and sanitized server settings.",
  "The monitoring agent should back off when a dependency is unavailable.",
  "The tunnel status panel should distinguish a closed session from a failed one.",
  "A login failure can originate in the identity workflow or in local policy.",
  "The server configuration is reviewed before each planned upgrade.",
  "The key inventory should include inactive credentials awaiting removal.",
  "The client configuration should be exported without credential values.",
  "The agent deployment should preserve the current logging policy.",
  "A port collision should produce a clear startup error.",
  "A timeout during login does not necessarily imply an invalid password.",
  "The worker pool should drain before the process shuts down.",
  "The connection limit should be sized for the expected request volume.",
  "The retry policy should avoid synchronized bursts across clients.",
] as const;

test("fresh technical prose corpus has 150 distinct sentences", () => {
  assert.equal(proseCorpus.length, 150);
  assert.equal(new Set(proseCorpus).size, 150);
});
for (const sentence of proseCorpus) {
  test(`technical prose corpus: ${sentence}`, () => {
    assert.deepEqual(findInternalHostnames("prose.txt", sentence), [], sentence);
    assert.deepEqual(findHostnames("prose.txt", sentence), [], sentence);
  });
}
test("technical prose corpus stays clean as one document", () => {
  assert.deepEqual(findInternalHostnames("prose.txt", proseCorpus.join("\n")), []);
});

const hostCorpus = [
  "ssh srv42",
  "ssh nas-1",
  "ping cache-2",
  "dig resolver01",
  "nc broker-1 443",
  "ssh user@vault",
  "ping gateway.lan",
  "dig resolver.internal",
  "nc service.home.arpa 443",
  "ssh srv42,",
  "_ssh srv42_",
  "ssh srv42|",
  "$ ssh vault",
  "$ ping gateway",
  "$ dig resolver",
  "$ nc broker 443",
  "$ sudo ssh vault",
  "~~~sh\nssh vault\n~~~",
  "```sh\nping gateway\n```",
  "Use `ssh vault` during maintenance",
  "~~~sh\nsudo ssh vault\n~~~",
  "Use ssh nas-1, during maintenance",
  "Use ssh srv42|cat",
  "openssl s_client -connect vault:443",
  "~~~sh\nthe proxy at vault:443\n~~~",
  "$ ssh keys",
  "$ ping access",
  "$ dig times",
  "$ nc output 443",
  "$ ssh config",
  "$ ssh enabled",
  "$ ssh works",
] as const;
for (const text of hostCorpus) {
  test(`positive host corpus: ${text}`, () => {
    assert.ok(findInternalHostnames("command.txt", text).length, text);
  });
}
for (const text of [
  "SSH agent forwarding is off.",
  "SSH tunnels are supported.",
  "SSH hardening is out of scope.",
  "SSH login is disabled.",
  "SSH client configuration is up to you.",
  "Ping latency matters.",
  "Dig deeper if needed.",
  "ssh key setup, then deploy",
  "ssh vault",
  "ssh -v vault",
  "ping gateway, then inspect",
  "dig resolver",
  "nc broker 443",
]) {
  test(`command words alone remain prose: ${text}`, () => {
    assert.deepEqual(findInternalHostnames("prose.txt", text), []);
  });
}
const shortNames = EXAMPLE_TOOLS.filter((name) => name.length <= 2);
for (const tool of shortNames) {
  for (const verb of AUTHORSHIP_VERBS) {
    for (const identifier of [
      `${tool.toLowerCase()}${verb[0]?.toUpperCase()}${verb.slice(1).replaceAll("-", "")}`,
      `${tool.toUpperCase()}${verb.toUpperCase().replaceAll("-", "")}`,
    ]) {
      test(`short tool prefix is ordinary: ${identifier}`, () => {
        assert.deepEqual(scanText("fixture", identifier), []);
      });
    }
    for (const identifier of [
      `${tool.toLowerCase()}_${verb.replaceAll("-", "_")}`,
      `${tool.toUpperCase()}_${verb.toUpperCase().replaceAll("-", "_")}`,
      `${tool.toLowerCase()}-${verb}`,
    ]) {
      test(`short tool credit requires a separator: ${identifier}`, () => {
        assert.ok(scanText("fixture", identifier).length);
      });
    }
  }
  for (const noun of ["credit", "author", "attribution"]) {
    test(`short tool noun also requires a separator: ${noun}`, () => {
      assert.deepEqual(scanText("fixture", `${tool}${noun}`), []);
      assert.ok(scanText("fixture", `${tool}_${noun}`).length);
    });
  }
}
