import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { CoordError, type ExecutionMode } from "./protocol.js";
import { captureDigest, gitText } from "./checkpoint.js";
import { probePackageManager } from "./doctor.js";

export interface EnvironmentRequirement { name: string; modes: ExecutionMode[]; type?: "string" | "url" | "integer" | "boolean" }
export interface SecretProvider { id: string; resolve(names: string[]): Promise<Record<string, string | undefined>> }
export interface EnvironmentOptions { processEnv?: NodeJS.ProcessEnv; files?: string[]; providers?: SecretProvider[] }
export interface EnvironmentReport {
  status: "PASS" | "BLOCKED_ENV"; mode: ExecutionMode; missing: string[]; invalid: string[];
  sources: { name: string; source: string; present: boolean }[]; configurationDigest: string;
}
async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new CoordError("BLOCKED_ENV", "Selected environment/lock file is unsupported or too large");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) throw new CoordError("BLOCKED_ENV", "Selected environment/lock file changed before read");
    const buffer = Buffer.alloc(info.size + 1); let read = 0;
    while (read < buffer.length) { const chunk = await handle.read(buffer, read, buffer.length - read, read); if (!chunk.bytesRead) break; read += chunk.bytesRead; }
    if (read > info.size) throw new CoordError("BLOCKED_ENV", "Selected environment/lock file changed during read");
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new CoordError("BLOCKED_ENV", "Selected environment/lock file changed during read");
    return buffer.subarray(0, read);
  } finally { await handle.close(); }
}
function envFile(content: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new CoordError("BLOCKED_ENV", "Selected environment file has unsupported syntax; values withheld");
    let value = match[2]!;
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (!value.endsWith(quote!) || value.length < 2 || /[\\\r\n]/.test(value)) throw new CoordError("BLOCKED_ENV", "Environment file escaping/multiline values need an approved provider");
      value = value.slice(1, -1);
    } else value = value.replace(/\s+#.*$/, "").trim();
    if (/\$\{|\$\(|\$[A-Za-z_]|`/.test(value)) throw new CoordError("BLOCKED_ENV", "Environment file expansion is unsupported; values withheld");
    result[match[1]!] = value;
  }
  return result;
}
function validType(value: string, type: EnvironmentRequirement["type"]): boolean {
  if (!value.trim()) return false;
  if (type === "integer") return /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value));
  if (type === "boolean") return value === "true" || value === "false";
  if (type === "url") { try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; } }
  return true;
}
/** Reports presence/type/source identifiers only. Resolved secret values never leave this function. */
export async function checkEnvironment(requirements: EnvironmentRequirement[], mode: ExecutionMode, options: EnvironmentOptions = {}): Promise<EnvironmentReport> {
  if (!["advisory", "manual", "managed"].includes(mode) || requirements.some(item => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item.name) || !item.modes.every(value => ["advisory", "manual", "managed"].includes(value)) || (item.type && !["string", "url", "integer", "boolean"].includes(item.type))) || new Set(requirements.map(item => item.name)).size !== requirements.length) throw new CoordError("INVALID_INPUT", "Invalid mode-specific environment contract");
  const required = requirements.filter(item => item.modes.includes(mode));
  const names = required.map(item => item.name);
  const values = new Map<string, { value: string; source: string }>();
  const effectiveProcess = options.processEnv ?? process.env;
  for (const name of names) if (effectiveProcess[name] !== undefined) values.set(name, { value: effectiveProcess[name]!, source: "process" });
  // First explicit file/provider wins; actual process exports always override them, including empty values.
  for (const [index, path] of (options.files ?? []).entries()) {
    if (names.every(name => values.has(name))) break;
    let contents: Buffer;
    try { contents = await readBounded(path, 1024 * 1024); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const parsed = envFile(contents.toString("utf8"));
    for (const name of names) if (!values.has(name) && parsed[name] !== undefined) values.set(name, { value: parsed[name], source: `file:${index}` });
  }
  for (const provider of options.providers ?? []) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(provider.id)) throw new CoordError("INVALID_INPUT", "Provider requires a nonsecret identifier");
    const requested = names.filter(name => !values.has(name));
    if (!requested.length) continue;
    let resolved: Record<string, string | undefined>;
    try { resolved = await provider.resolve(requested); } catch { throw new CoordError("BLOCKED_ENV", "Approved secret provider unavailable; values withheld"); }
    for (const name of requested) if (typeof resolved[name] === "string") values.set(name, { value: resolved[name]!, source: `provider:${provider.id}` });
  }
  const missing: string[] = [], invalid: string[] = [];
  const sources = required.map(item => {
    const found = values.get(item.name), present = Boolean(found?.value.trim());
    if (!present) missing.push(item.name); else if (!validType(found!.value, item.type)) invalid.push(item.name);
    return { name: item.name, source: found?.source ?? "missing", present };
  });
  const configurationDigest = captureDigest({ mode, requirements: required, sources, missing, invalid });
  return { status: missing.length || invalid.length ? "BLOCKED_ENV" : "PASS", mode, missing, invalid, sources, configurationDigest };
}
export function requireEnvironment(report: EnvironmentReport): void {
  if (report.status !== "PASS") throw new CoordError("BLOCKED_ENV", `Required effective environment missing/invalid: ${[...report.missing, ...report.invalid].join(", ")}`);
}
export interface SetupManifest { schemaVersion: 1; node: string; locks: { path: string; sha256: string }[]; git: string; packageManagers: Awaited<ReturnType<typeof probePackageManager>>[]; setupCommands: string[][] }
/** Captures lock identities; it does not install dependencies or execute repository scripts. */
export async function inspectSetup(repo: string, setupCommands: string[][] = []): Promise<SetupManifest> {
  const locks: SetupManifest["locks"] = [];
  for (const path of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) {
    try { locks.push({ path, sha256: createHash("sha256").update(await readBounded(join(repo, path), 16 * 1024 * 1024)).digest("hex") }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const command of setupCommands) {
    const [binary, action, ...flags] = command;
    if (!(binary === "npm" && action === "ci") && !(["pnpm", "bun"].includes(binary ?? "") && action === "install" && flags.includes("--frozen-lockfile")) && !(binary === "yarn" && action === "install" && flags.includes("--immutable"))) throw new CoordError("BLOCKED_ENV", "Setup policy requires a supported lockfile-preserving command");
    const allowedFlags = ["--frozen-lockfile", "--immutable", "--ignore-scripts", "--offline", "--prefer-offline", "--no-audit", "--no-fund"];
    if (flags.some(flag => !allowedFlags.includes(flag))) throw new CoordError("BLOCKED_ENV", "Unsupported setup option requires an explicit policy implementation");
    const requiredLock = binary === "npm" ? ["package-lock.json"] : binary === "pnpm" ? ["pnpm-lock.yaml"] : binary === "yarn" ? ["yarn.lock"] : ["bun.lock", "bun.lockb"];
    if (!locks.some(lock => requiredLock.includes(lock.path))) throw new CoordError("BLOCKED_ENV", "Approved dependency setup requires its matching available lockfile");
  }
  const packageManagers = [];
  for (const binary of new Set(setupCommands.map(command => command[0]! as "npm" | "pnpm" | "bun" | "yarn"))) {
    const observed = await probePackageManager(binary);
    if (observed.status !== "PASS") throw new CoordError("BLOCKED_ENV", "Selected package manager version could not be verified without installation");
    packageManagers.push(observed);
  }
  return { schemaVersion: 1, node: process.version, locks, git: await gitText(repo, ["--version"]), packageManagers, setupCommands: structuredClone(setupCommands) };
}
