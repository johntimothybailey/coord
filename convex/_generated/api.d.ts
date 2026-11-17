/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as attribution from "../attribution.js";
import type * as artifacts from "../artifacts.js";
import type * as auth from "../auth.js";
import type * as authCore from "../authCore.js";
import type * as oauthAuthority from "../oauthAuthority.js";
import type * as mcpConsent from "../mcpConsent.js";
import type * as checkpoints from "../checkpoints.js";
import type * as crons from "../crons.js";
import type * as dispatch from "../dispatch.js";
import type * as exports from "../exports.js";
import type * as goals from "../goals.js";
import type * as lifecycle from "../lifecycle.js";
import type * as machines from "../machines.js";
import type * as memories from "../memories.js";
import type * as messages from "../messages.js";
import type * as projects from "../projects.js";
import type * as publications from "../publications.js";
import type * as scans from "../scans.js";
import type * as server from "../server.js";
import type * as tasks from "../tasks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  attribution: typeof attribution;
  artifacts: typeof artifacts;
  auth: typeof auth;
  authCore: typeof authCore;
  oauthAuthority: typeof oauthAuthority;
  mcpConsent: typeof mcpConsent;
  checkpoints: typeof checkpoints;
  crons: typeof crons;
  dispatch: typeof dispatch;
  exports: typeof exports;
  goals: typeof goals;
  lifecycle: typeof lifecycle;
  machines: typeof machines;
  memories: typeof memories;
  messages: typeof messages;
  projects: typeof projects;
  publications: typeof publications;
  scans: typeof scans;
  server: typeof server;
  tasks: typeof tasks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  auth: import("@convex-dev/auth/_generated/component.js").ComponentApi<"auth">;
  mcp: import("@convex-dev/mcp/_generated/component.js").ComponentApi<"mcp">;
};
