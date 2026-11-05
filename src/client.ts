import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, CLIENT_VERSION, CAPABILITIES, requireHandshake } from "./protocol.js";
import type { VersionHandshake } from "./protocol.js";
import { readAgentCredential, resolveWorkspace } from "./config.js";
import type { WorkspaceConfig } from "./config.js";

export class BackendClient {
  private readonly http: ConvexHttpClient;
  constructor(readonly config: WorkspaceConfig, private readonly token: string) { this.http = new ConvexHttpClient(config.backendUrl); }
  private args(payload: Record<string, Value>, requestId: string = randomUUID()): Record<string, Value> {
    return { ...payload, token: this.token, protocolVersion: PROTOCOL_VERSION, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], backendId: this.config.backendId, projectId: this.config.projectId, requestId };
  }
  async query(name: string, payload: Record<string, Value> = {}): Promise<unknown> { return this.http.query(makeFunctionReference<"query">(name), this.args(payload)); }
  async mutation(name: string, payload: Record<string, Value>, requestId: string): Promise<unknown> { return this.http.mutation(makeFunctionReference<"mutation">(name), this.args(payload, requestId)); }
  withRunToken(token: string): BackendClient { return new BackendClient(this.config, token); }
}
export async function connectWorkspace(cwd: string): Promise<BackendClient> {
  const { config } = await resolveWorkspace(cwd);
  const client = new BackendClient(config, await readAgentCredential(config));
  requireHandshake(await client.query("auth:handshake") as VersionHandshake);
  return client;
}
