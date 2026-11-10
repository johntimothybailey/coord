import { randomUUID, createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { canonicalJson } from "./canonical.js";
import { CLIENT_VERSION } from "./protocol.js";

interface ProbeOptions { declineOnly?: boolean; timeoutMs?: number; observe?: (observation: ConfirmationProbeObservation) => void }
export interface ConfirmationProbeObservation {
  kind: "no_effect_confirmation_probe";
  phase: "prepared" | "completed";
  client: { name: string; version: string };
  capabilities: { form: boolean; url: boolean };
  synthetic: { projectId: "coord-confirmation-probe"; action: "no_effect_check" | "no_effect_decline_check"; revision: 1; nonce: string; hash: string };
  message: string;
  outcome: "pending" | "capability_not_declared" | "accepted_response" | "declined_response" | "cancelled_response" | "invalid_response" | "timed_out" | "request_failed";
  responseAction: "accept" | "decline" | "cancel" | null;
  contentMatched: boolean;
  humanVerified: false;
  authorityGranted: false;
  sideEffects: "none";
}

// Client metadata is self-reported, not identity evidence. Never echo arbitrary capabilities or form content.
const metadata = (value: string | undefined): string => (value ?? "unknown").replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 128);

/** Shared by the ordinary plugin and a standalone server that has no backend or credential dependency. */
export function registerConfirmationProbe(server: McpServer, options: ProbeOptions = {}): void {
  const timeout = options.timeoutMs ?? 90_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 90_000) throw new Error("Invalid confirmation probe timeout");
  const declineOnly = options.declineOnly === true;
  server.registerTool(declineOnly ? "coord_confirmation_decline_probe" : "coord_confirmation_probe", {
    description: declineOnly
      ? "Test only a synthetic host Decline action using a fieldless form. Select the host Deny option, not text input. No arguments, backend access or real approval; acceptance cannot pass this negative-only check."
      : "Test a synthetic no-effect host confirmation form. No arguments, backend access or real approval; even an accepted response never proves human identity or grants authority.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  }, async (_args, extra) => {
    const reported = server.server.getClientVersion(), elicitation = server.server.getClientCapabilities()?.elicitation;
    const source = { projectId: "coord-confirmation-probe" as const, action: declineOnly ? "no_effect_decline_check" as const : "no_effect_check" as const, revision: 1 as const, nonce: randomUUID() };
    const synthetic = { ...source, hash: createHash("sha256").update(canonicalJson(source)).digest("hex") };
    const instruction = declineOnly
      ? "Test only Decline: choose the host Deny/Decline control. In the source-checked Codex fieldless form, select Deny (second choice) and submit. Do not type decline into a text field. Allow does not pass this check."
      : "To test accept, enter this public nonce only. Do not type decline or cancel into the nonce field: text submission is not a protocol action. The source-checked Codex nonce-entry form exposes cancellation, not a distinct Decline; use the separate decline probe for that path.";
    const message = `Synthetic Coord host check only. No effect: no approval, record change, credential access or file synchronization.\nProject: ${synthetic.projectId}\nAction: ${synthetic.action}\nRevision: ${synthetic.revision}\nHash: ${synthetic.hash}\nPublic probe nonce: ${synthetic.nonce}\n${instruction} Do not enter a password or credential.`;
    const initial: ConfirmationProbeObservation = { kind: "no_effect_confirmation_probe", phase: "prepared", client: { name: metadata(reported?.name), version: metadata(reported?.version) }, capabilities: { form: !!elicitation?.form, url: !!elicitation?.url }, synthetic, message, outcome: "pending", responseAction: null, contentMatched: false, humanVerified: false, authorityGranted: false, sideEffects: "none" };
    options.observe?.(initial);
    let observation: ConfirmationProbeObservation = { ...initial, phase: "completed", outcome: "capability_not_declared" };
    if (initial.capabilities.form) {
      try {
        const requestedSchema: ElicitRequestFormParams["requestedSchema"] = declineOnly
          ? { type: "object", properties: {} }
          : { type: "object", properties: { nonce: { type: "string", title: "Public probe nonce", description: "Copy the public nonce displayed above; never enter a secret.", minLength: 36, maxLength: 36 } }, required: ["nonce"] };
        const response = await server.server.elicitInput({ mode: "form", message, requestedSchema }, { timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false, signal: extra.signal, relatedRequestId: extra.requestId });
        const content = response.content;
        const matched = !declineOnly && response.action === "accept" && !!content && Object.keys(content).length === 1 && content.nonce === synthetic.nonce;
        observation = { ...observation, responseAction: response.action, contentMatched: matched, outcome: response.action === "accept" ? matched ? "accepted_response" : "invalid_response" : response.action === "decline" ? "declined_response" : "cancelled_response" };
      } catch (error) {
        observation = { ...observation, outcome: error instanceof McpError && error.code === ErrorCode.RequestTimeout ? "timed_out" : "request_failed" };
      }
    }
    options.observe?.(observation);
    return { content: [{ type: "text", text: JSON.stringify(observation) }] };
  });
}

export function createConfirmationProbeServer(options: ProbeOptions = {}): McpServer {
  const server = new McpServer({ name: "coord-confirmation-probe", version: CLIENT_VERSION });
  registerConfirmationProbe(server, options);
  return server;
}

export async function runConfirmationProbeStdio(streams: { stdin: Readable; stdout: Writable } = { stdin: process.stdin, stdout: process.stdout }, options: Pick<ProbeOptions, "declineOnly"> = {}): Promise<McpServer> {
  const server = createConfirmationProbeServer({ ...options, observe: observation => { process.stderr.write(`COORD_CONFIRMATION_PROBE ${JSON.stringify(observation)}\n`); } });
  const close = (): void => { void server.close(); };
  streams.stdin.once("end", close); streams.stdin.once("close", close); streams.stdout.once("error", close);
  server.server.onclose = () => { streams.stdin.off("end", close); streams.stdin.off("close", close); streams.stdout.off("error", close); };
  try { await server.connect(new StdioServerTransport(streams.stdin, streams.stdout)); }
  catch (error) { await server.close(); throw error; }
  return server;
}
