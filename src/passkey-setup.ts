import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { approvalOriginForBackend, decode64 } from "./passkeys.js";
import { confirmExactApproval, openOperatorSession } from "./approval.js";
import type { OperatorIo } from "./approval.js";
import { CoordError } from "./protocol.js";
import { backendFailure } from "./hooks.js";

export const PASSKEY_USAGE = "Usage: coord setup passkey <plan.json> <absolute-encrypted-vault> [--revoke <public-credential-id>]";
interface SetupIo extends OperatorIo { openBrowser?: (url: string) => Promise<void>; wait?: (ms: number) => Promise<void> }
async function browser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  await new Promise<void>((resolve, reject) => { const child = spawn(command, [url], { stdio: "ignore", shell: false }); child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("Browser unavailable"))); });
}
/** Human-operated one-time binding. Never called from MCP; all secret input uses the existing protected terminal. */
export async function passkeySetupCommand(args: string[], io: SetupIo = {}): Promise<void> {
  const [plan, vault, flag, credentialId] = args;
  if (!plan || !vault || (args.length !== 2 && !(args.length === 4 && flag === "--revoke" && credentialId && /^[A-Za-z0-9_-]{1,2048}$/.test(credentialId)))) throw new CoordError("INVALID_INPUT", PASSKEY_USAGE);
  const session = await openOperatorSession({ plan, vault }, io), projectId = session.plan.config.projectId;
  try {
    if (flag === "--revoke") {
      await confirmExactApproval(session, `revoke passkey ${projectId} ${credentialId}`);
      const result = await session.client.mutation("approvalAuth:revokePasskey", { credentialId: credentialId! }, randomUUID()) as { credentialId?: string; revoked?: boolean };
      if (result?.credentialId !== credentialId || result.revoked !== true) throw new CoordError("BLOCKED_ENV", "Passkey revocation unconfirmed; inspect protected status before retrying");
      session.write(`${JSON.stringify({ credentialId, revoked: true })}\n`); return;
    }
    await confirmExactApproval(session, `enroll passkey ${projectId}`);
    const enrollmentId = randomUUID();
    const begin = await session.client.mutation("approvalAuth:beginEnrollment", { enrollmentId }, randomUUID()) as { enrollmentId: string; memberId: string; url: string; expiresAt: number };
    const url = new URL(begin.url), origin = approvalOriginForBackend(session.plan.config.backendUrl);
    if (begin.enrollmentId !== enrollmentId || begin.memberId !== session.plan.humanId || url.origin !== origin || url.pathname !== "/approval" || url.href !== `${origin}/approval?enrollment=${encodeURIComponent(enrollmentId)}` || !Number.isSafeInteger(begin.expiresAt) || begin.expiresAt <= Date.now() || begin.expiresAt > Date.now() + 11 * 60_000) throw new CoordError("BLOCKED_ENV", "Backend did not confirm this exact enrollment");
    session.write(`Create a passkey in the protected browser page, then enter its OWN fingerprint here.\n${url.href}\n`);
    try { await (io.openBrowser ?? browser)(url.href); } catch { session.write("Open the displayed HTTPS link in your browser; no key is authorized yet.\n"); }
    while (Date.now() < begin.expiresAt) {
      const status = await session.client.query("approvalAuth:enrollmentStatus", { enrollmentId }) as { enrollmentId: string; memberId: string; fingerprint: string | null; credentialId: string | null; expiresAt: number };
      if (status.enrollmentId !== enrollmentId || status.memberId !== session.plan.humanId || status.expiresAt !== begin.expiresAt) throw new CoordError("BLOCKED_ENV", "Enrollment identity changed");
      if (status.fingerprint) {
        if (!status.credentialId || decode64(status.credentialId, 2048).length > 1024 || !/^[A-Za-z0-9_-]{43}$/.test(status.fingerprint)) throw new CoordError("BLOCKED_ENV", "Invalid enrollment fingerprint");
        const browserFingerprint = await session.prompt("Browser's own fingerprint (43 characters, copied from the browser): ", false);
        if (!/^[A-Za-z0-9_-]{43}$/.test(browserFingerprint)) throw new CoordError("NEEDS_HUMAN", "Browser fingerprint must be exactly 43 base64url characters; no key was authorized");
        if (browserFingerprint !== status.fingerprint) throw new CoordError("NEEDS_HUMAN", "Browser fingerprint did not match the staged passkey; no key was authorized");
        session.write(`Browser fingerprint matched the staged passkey for project ${projectId}.\n`);
        await confirmExactApproval(session, `enroll passkey ${projectId} ${browserFingerprint}`);
        const result = await session.client.mutation("approvalAuth:finishEnrollment", { enrollmentId, fingerprint: browserFingerprint }, randomUUID()) as { credentialId?: string; memberId?: string; fingerprint?: string; enrolledAt?: number };
        if (!result || result.credentialId !== status.credentialId || result.memberId !== session.plan.humanId || result.fingerprint !== status.fingerprint || !Number.isSafeInteger(result.enrolledAt) || result.enrolledAt! <= 0 || result.enrolledAt! > Date.now() + 60_000) throw new CoordError("BLOCKED_ENV", "Passkey enrollment reply unconfirmed; preserve the key and inspect protected enrollment status before retrying");
        session.write(`${JSON.stringify({ credentialId: result.credentialId, memberId: result.memberId, fingerprint: result.fingerprint, enrolledAt: result.enrolledAt })}\nPasskey enrolled. Routine rule approval now uses the browser link from chat.\n`); return;
      }
      await (io.wait ?? delay)(2000);
    }
    throw new CoordError("NEEDS_HUMAN", "Enrollment expired without binding a key; start a new protected enrollment");
  } catch (error) { throw backendFailure(error); }
}
