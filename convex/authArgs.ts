import { v } from "convex/values";
export const identityArgs = { token: v.string(), oauthBearer: v.optional(v.string()), protocolVersion: v.number(), clientVersion: v.string(), capabilities: v.array(v.string()), backendId: v.string(), projectId: v.string(), requestId: v.string() };
export const runArgs = { ...identityArgs, taskId: v.string(), runId: v.string(), epoch: v.number(), goalRevision: v.number() };
