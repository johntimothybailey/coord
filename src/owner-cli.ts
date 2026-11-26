import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// No generic agent dispatch surface. The official CLI alone owns deployment
// authentication; arguments to these facilities contain selectors/digests only.
export type OwnerOperation = "operatorRecovery:inspect" | "operatorRecovery:recoverAttempt" | "connect:installOwnerLink" | "connect:inspectOwnerLink" | "connect:inspectLink";
export function invokeOwnerCli(deploymentName: string, operation: OwnerOperation, args: Record<string, unknown>): unknown {
  if (!["operatorRecovery:inspect", "operatorRecovery:recoverAttempt", "connect:installOwnerLink", "connect:inspectOwnerLink", "connect:inspectLink"].includes(operation)) throw new Error("Owner operation is not allowlisted");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const output = execFileSync(process.execPath, [join(root, "node_modules/convex/bin/main.js"), "run", operation, JSON.stringify(args), "--deployment", deploymentName, "--typecheck", "disable", "--codegen", "disable"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 128 * 1024, encoding: "utf8" });
  return JSON.parse(output) as unknown;
}
