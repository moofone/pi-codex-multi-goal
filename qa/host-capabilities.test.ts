import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Phase 0 host capability probes (Feature: goal-memory-and-limits, Task 1).
//
// Drives the REAL ExtensionRunner from the installed
// @earendil-works/pi-coding-agent peer and records explicit
// [pass]/[fail]/[unavailable] outcomes in qa/evidence/host-capabilities.txt
// for:
//   (1) deny-including-retries      before_provider_request payload observation
//                                   and denial of the next request incl. retries
//   (2) abort                       ctx.abort() on the extension context
//   (3) context-filter              context event returning a filtered
//                                   provider-visible messages list
//   (4) tool-ctx-has-no-newSession  tool execute ctx is ExtensionContext and
//                                   has no newSession (command ctx only)
//
// A missing peer or a missing live agent-loop helper is recorded as
// [unavailable] — never as a passing admission barrier. The test exits 0 as
// long as the evidence file records an explicit outcome for all four named
// probes. These are boundary probes against the real runner dispatch paths;
// they are not full provider/agent-loop tests.

const here = dirname(fileURLToPath(import.meta.url));
const evidencePath = join(here, "evidence", "host-capabilities.txt");

type Outcome = "pass" | "fail" | "unavailable";

interface ProbeResult {
  label: string;
  outcome: Outcome;
  detail: string;
}

interface ProbeRun {
  peerVersion: string;
  peerAvailable: boolean;
  liveLoopAvailable: boolean;
  liveLoop: string;
  probes: ProbeResult[];
}

const PROBE_LABELS = [
  "(1) deny-including-retries",
  "(2) abort",
  "(3) context-filter",
  "(4) tool-ctx-has-no-newSession",
];

const unavailableRun = (reason: string): ProbeRun => ({
  peerVersion: "unavailable",
  peerAvailable: false,
  liveLoopAvailable: false,
  liveLoop: `unavailable — peer @earendil-works/pi-coding-agent is not installed/resolvable: ${reason}`,
  probes: PROBE_LABELS.map((label) => ({
    label,
    outcome: "unavailable" as Outcome,
    detail: `peer unavailable: ${reason}`,
  })),
});

async function loadPeer(): Promise<{ peer: any } | { error: unknown }> {
  try {
    return { peer: await import("@earendil-works/pi-coding-agent") };
  } catch (error) {
    return { error };
  }
}

function buildProbeHost(peer: any) {
  const observed: { payload: any; eventCtx: any; abortCalls: number } = {
    payload: undefined,
    eventCtx: undefined,
    abortCalls: 0,
  };
  const handlers = new Map<string, any[]>([
    ["session_start", [async (_event: unknown, ctx: any) => { observed.eventCtx = ctx; }]],
    // Two handlers: the first observes and replaces the payload, the second
    // attempts to DENY the request by throwing.
    ["before_provider_request", [
      async (event: any) => {
        observed.payload = event.payload;
        return { ...event.payload, multiGoalProbe: "replaced-by-handler-1" };
      },
      async () => {
        throw new Error("multi-goal probe deny: this provider request must not proceed");
      },
    ]],
    ["context", [async (event: any) => ({
      messages: event.messages.filter((m: any) => m.role !== "multi-goal-drop-me"),
    })]],
  ]);
  const path = "<multi-goal-host-capabilities-probe>";
  const extension = {
    path,
    resolvedPath: path,
    sourceInfo: peer.createSyntheticSourceInfo(path, { source: "qa/host-capabilities.test.ts" }),
    handlers,
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
  const cwd = process.cwd();
  const runtime = peer.createExtensionRuntime();
  const sessionManager = peer.SessionManager.inMemory(cwd);
  const runner = new peer.ExtensionRunner([extension], runtime, cwd, sessionManager, {});
  runner.bindCore(
    {
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      refreshTools: () => {},
      getCommands: () => [],
      setModel: () => {},
      getThinkingLevel: () => undefined,
      setThinkingLevel: () => {},
    },
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => { observed.abortCalls += 1; },
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
    },
  );
  return { runner, observed };
}

async function probeDenyIncludingRetries(host: any): Promise<ProbeResult> {
  const label = PROBE_LABELS[0];
  const original = {
    model: "probe-model",
    messages: [{ role: "user", content: "multi-goal-probe" }],
    tools: [],
  };
  let denyThrew = false;
  let returned: any;
  try {
    returned = await host.runner.emitBeforeProviderRequest(original);
  } catch {
    denyThrew = true;
  }
  const canObserve = host.observed.payload === original;
  const canReplace = returned?.multiGoalProbe === "replaced-by-handler-1";
  if (!canObserve) {
    return { label, outcome: "unavailable", detail: "the handler did not observe the provider payload; probe harness did not behave as expected" };
  }
  if (denyThrew) {
    // A throw propagating would mean a deny channel exists — still not proof
    // that the provider request is withheld on retries without a live loop.
    return {
      label,
      outcome: "pass",
      detail: `a throwing handler propagates out of emitBeforeProviderRequest (payload observed: yes, replaced: ${canReplace}); whether the provider request including retries is actually withheld requires a live agent loop: unavailable`,
    };
  }
  return {
    label,
    outcome: "fail",
    detail: `before_provider_request observes the provider payload (${canObserve}) and may REPLACE it (${canReplace}), but a throwing deny handler is swallowed by ExtensionRunner and the request still proceeds (returned payload: ${JSON.stringify(returned)?.slice(0, 120)}). The hook fires once per agent-loop request BEFORE the provider's internal retry loop (installed pi-ai: onPayload precedes retryProviderRequest — source inspection, not a live loop), so HTTP-level retries are not gated and no deny channel exists. Admission must not be claimed on this API; the Task 5 fallback (stop scheduling once the allowance is exhausted) applies.`,
  };
}

async function probeAbort(host: any): Promise<ProbeResult> {
  const label = PROBE_LABELS[1];
  await host.runner.emit({ type: "session_start" });
  const ctx = host.observed.eventCtx;
  if (!ctx || typeof ctx.abort !== "function") {
    return { label, outcome: "fail", detail: "ctx.abort is missing on the extension context handed to event handlers" };
  }
  ctx.abort();
  if (host.observed.abortCalls !== 1) {
    return { label, outcome: "fail", detail: "ctx.abort() did not reach the host abort action" };
  }
  return {
    label,
    outcome: "pass",
    detail: "ctx.abort() exists on the ExtensionContext handed to extensions and invokes the host abort action (verified via the real ExtensionRunner with a counting stub). Which work abort() cancels (process-global scope) is NOT verified here; Task 6 must prove ownership before aborting.",
  };
}

async function probeContextFilter(host: any): Promise<ProbeResult> {
  const label = PROBE_LABELS[2];
  const messages = [
    { role: "user", content: "KEEP-multi-goal-probe" },
    { role: "multi-goal-drop-me", content: "PREVIOUS_STEP_TRANSCRIPT_SENTINEL" },
  ];
  const filtered = await host.runner.emitContext(messages);
  const dropped = filtered.length === 1
    && !JSON.stringify(filtered).includes("PREVIOUS_STEP_TRANSCRIPT_SENTINEL")
    && JSON.stringify(filtered).includes("KEEP-multi-goal-probe");
  if (!dropped) {
    return {
      label,
      outcome: "fail",
      detail: `the context event did not drop the filtered entry; emitContext returned: ${JSON.stringify(filtered).slice(0, 160)}`,
    };
  }
  return {
    label,
    outcome: "pass",
    detail: "a context handler's returned { messages } replaces the provider-visible list: ExtensionRunner.emitContext dropped the filtered entry (verified by driving the real runner). The SDK wires emitContext as the request transformContext feeding the provider payload; end-to-end confirmation in a live agent loop: unavailable.",
  };
}

async function probeToolContext(host: any): Promise<ProbeResult> {
  const label = PROBE_LABELS[3];
  const toolCtx = host.runner.createContext();
  const commandCtx = host.runner.createCommandContext();
  const toolHasNoNewSession = !("newSession" in toolCtx);
  const commandHasNewSession = typeof commandCtx?.newSession === "function";
  if (toolHasNoNewSession && commandHasNewSession) {
    return {
      label,
      outcome: "pass",
      detail: "createContext() — the context passed to tool execute — has no newSession; createCommandContext() does (verified against the installed runner). Session replacement is unreachable from a tool callback.",
    };
  }
  return {
    label,
    outcome: "fail",
    detail: `tool ctx exposes newSession: ${!toolHasNoNewSession}; command ctx exposes newSession: ${commandHasNewSession}`,
  };
}

async function runProbes(): Promise<ProbeRun> {
  const loaded = await loadPeer();
  if (!("peer" in loaded)) {
    const reason = loaded.error instanceof Error ? loaded.error.message : String(loaded.error);
    return unavailableRun(reason);
  }
  const peer = loaded.peer;
  const base: ProbeRun = {
    peerVersion: typeof peer.VERSION === "string" ? peer.VERSION : "unknown",
    peerAvailable: true,
    liveLoopAvailable: false,
    liveLoop: typeof peer.createAgentSession === "function"
      ? "unavailable — createAgentSession exists but performs real provider requests (credentials/network required); there is no offline-drivable live agent loop, so end-to-end retry/admission behavior is NOT behaviorally verified. Downstream tasks must not claim admission or isolation guarantees on these probes alone."
      : "unavailable — no agent-loop helper is exported by the installed peer",
    probes: [],
  };
  let host: any;
  try {
    host = buildProbeHost(peer);
  } catch (error) {
    const reason = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    base.probes = PROBE_LABELS.map((label) => ({
      label,
      outcome: "unavailable" as Outcome,
      detail: `probe host could not be constructed: ${reason}`,
    }));
    return base;
  }
  for (const probe of [probeDenyIncludingRetries, probeAbort, probeContextFilter, probeToolContext]) {
    try {
      base.probes.push(await probe(host));
    } catch (error) {
      const reason = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
      base.probes.push({
        label: PROBE_LABELS[base.probes.length],
        outcome: "unavailable",
        detail: `probe threw: ${reason}`,
      });
    }
  }
  return base;
}

function renderEvidence(run: ProbeRun): string {
  const lines = [
    "# Pi host capability probes — Phase 0 (goal-memory-and-limits Task 1)",
    "",
    `Date: ${new Date().toISOString()}`,
    `Node: ${process.version}`,
    `Peer: @earendil-works/pi-coding-agent ${run.peerVersion}`,
    `Live agent-loop helper: ${run.liveLoop}`,
    "",
  ];
  for (const probe of run.probes) {
    lines.push(`Probe ${probe.label}: [${probe.outcome}]`);
    for (const detail of probe.detail.split("\n")) {
      lines.push(`  ${detail}`);
    }
    lines.push("");
  }
  lines.push(
    "Policy: missing peer or missing live agent-loop helper is recorded as",
    "[unavailable]; a faked passing admission barrier is a test failure. These",
    "probes drive the installed peer's ExtensionRunner dispatch paths directly",
    "(boundary probes); they are not full provider/agent-loop tests.",
    "",
  );
  return lines.join("\n");
}

test("records four probe outcomes", async () => {
  const run = await runProbes();
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, renderEvidence(run));
  const text = readFileSync(evidencePath, "utf8");
  for (const [index, label] of PROBE_LABELS.entries()) {
    assert.match(
      text,
      new RegExp(`Probe \\(${index + 1}\\) ${label.slice(4)}: \\[(pass|fail|unavailable)\\]`),
      `qa/evidence/host-capabilities.txt must record an explicit pass/fail/unavailable outcome for ${label}`,
    );
  }
  if (!run.peerAvailable) {
    assert.doesNotMatch(text, /\[pass\]/, "a missing peer must not produce passing probe outcomes");
  }
  if (!run.liveLoopAvailable) {
    assert.doesNotMatch(
      text,
      /deny-including-retries: \[pass\]/,
      "without a live agent loop the admission barrier must never be recorded as passing",
    );
  }
});
