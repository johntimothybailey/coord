/** WebAuthn ES256 assertion checks. Crypto primitives are the platform Web Crypto API. */
export interface PasskeyAssertion { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null }
const encoder = new TextEncoder();
export function encode64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
export function decode64(value: string, max = 8192): Uint8Array {
  if (!value || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoded passkey data");
  const text = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  const bytes = Uint8Array.from(text, character => character.charCodeAt(0));
  if (encode64(bytes) !== value) throw new Error("Noncanonical encoded passkey data");
  return bytes;
}
export function randomChallenge(): string { return encode64(crypto.getRandomValues(new Uint8Array(32))); }
export async function bytesHash(bytes: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)); }
export async function passkeyFingerprint(credentialId: string, spki: string, binding: string): Promise<string> { return encode64(await bytesHash(encoder.encode(`${credentialId}\n${spki}\n${binding}`))); }
/** WebAuthn authenticators return an ASN.1 DER ECDSA signature; Web Crypto expects r||s. */
export function derSignature(bytes: Uint8Array): Uint8Array {
  let index = 0;
  if (bytes[index++] !== 0x30 || bytes[index++] !== bytes.length - 2 || bytes.length > 72) throw new Error("Invalid ES256 signature");
  const output = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (bytes[index++] !== 2) throw new Error("Invalid ES256 integer");
    const length = bytes[index++]!;
    if (length < 1 || length > 33 || index + length > bytes.length || (bytes[index]! & 0x80)) throw new Error("Invalid ES256 integer");
    let value = bytes.slice(index, index + length); index += length;
    if (value[0] === 0 && value.length > 1) {
      if (!(value[1]! & 0x80)) throw new Error("Nonminimal ES256 integer");
      value = value.slice(1);
    }
    if (value.length > 32 || value.every(byte => byte === 0)) throw new Error("Invalid ES256 integer");
    output.set(value, part * 32 + 32 - value.length);
  }
  if (index !== bytes.length) throw new Error("Trailing ES256 signature data");
  return output;
}
export function trustedApprovalOrigin(value: string | undefined): string {
  if (!value) throw new Error("Approval origin is not configured");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || !/^[a-z0-9-]+\.convex\.site$/.test(url.hostname)) throw new Error("Invalid approval origin");
  return url.origin;
}
export function approvalOriginForBackend(backendUrl: string): string {
  const url = new URL(backendUrl);
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.convex\.cloud$/.test(url.hostname) || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error("Unsupported approval backend");
  return trustedApprovalOrigin(`https://${url.hostname.replace(/\.cloud$/, ".site")}`);
}
export async function verifyPasskey(assertion: PasskeyAssertion, options: { spki: string; origin: string; challenge: string; previousCounter: number; userHandle: string; requireUserHandle?: boolean }): Promise<number> {
  const origin = trustedApprovalOrigin(options.origin);
  decode64(assertion.credentialId, 2048);
  if (options.requireUserHandle && !assertion.userHandle) throw new Error("Discoverable account handle required");
  if (assertion.userHandle != null && (decode64(assertion.userHandle, 128).length !== 32 || assertion.userHandle !== options.userHandle)) throw new Error("Passkey account binding rejected");
  const dataBytes = decode64(assertion.clientDataJSON, 8192);
  const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(dataBytes)) as Record<string, unknown>;
  if (!data || typeof data !== "object" || data.type !== "webauthn.get" || data.origin !== origin || data.challenge !== options.challenge || (data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined) throw new Error("Passkey client binding rejected");
  if (decode64(options.challenge).length !== 32) throw new Error("Invalid challenge");
  const auth = decode64(assertion.authenticatorData, 8192);
  if (auth.length < 37 || (auth[32]! & 5) !== 5 || (auth[32]! & 0x40)) throw new Error("Verified user presence required");
  if ((auth[32]! & 0x10) && !(auth[32]! & 0x08)) throw new Error("Invalid backup flags");
  const rpHash = await bytesHash(encoder.encode(new URL(origin).hostname));
  if (!rpHash.every((byte, i) => byte === auth[i])) throw new Error("Passkey RP binding rejected");
  const count = new DataView(auth.buffer, auth.byteOffset + 33, 4).getUint32(0);
  if (options.previousCounter > 0 && count <= options.previousCounter) throw new Error("Passkey counter rejected");
  const spki = decode64(options.spki, 1024);
  const key = await crypto.subtle.importKey("spki", spki as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const hash = await bytesHash(dataBytes), signed = new Uint8Array(auth.length + hash.length); signed.set(auth); signed.set(hash, auth.length);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derSignature(decode64(assertion.signature, 256)) as BufferSource, signed as BufferSource)) throw new Error("Passkey signature rejected");
  return count;
}
