import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as deriveKey } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, parse, resolve, sep } from "node:path";
import { CoordError } from "./protocol.js";

export interface VaultBinding { backendId: string; backendUrl: string; projectId: string; humanId: string; }
interface Envelope { schemaVersion: 1; binding: VaultBinding; salt: string; iv: string; tag: string; ciphertext: string; }
export const MAX_LOCAL_FILE_BYTES = 128 * 1024;
const bindingText = (binding: VaultBinding): string => JSON.stringify([1, binding.backendId, binding.backendUrl, binding.projectId, binding.humanId]);
export const generateToken = (): string => randomBytes(32).toString("hex");
async function key(passphrase: string, salt: Buffer): Promise<Buffer> {
  if (Buffer.byteLength(passphrase) < 16 || Buffer.byteLength(passphrase) > 1024) throw new CoordError("INVALID_INPUT", "Use a passphrase of 16–1024 UTF-8 bytes");
  return new Promise((resolve, reject) => deriveKey(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
}
export async function encryptVault(value: unknown, passphrase: string, binding: VaultBinding): Promise<string> {
  const salt = randomBytes(16), iv = randomBytes(12), secret = await key(passphrase, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", secret, iv);
    cipher.setAAD(Buffer.from(bindingText(binding)));
    const plaintext = Buffer.from(JSON.stringify(value));
    try {
      if (plaintext.length > MAX_LOCAL_FILE_BYTES / 2) throw new CoordError("INVALID_INPUT", "Credential bundle exceeds local limit");
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const encoded = JSON.stringify({ schemaVersion: 1, binding, salt: salt.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") } satisfies Envelope);
      if (Buffer.byteLength(encoded) > MAX_LOCAL_FILE_BYTES) throw new CoordError("INVALID_INPUT", "Credential bundle exceeds local limit");
      return encoded;
    } finally { plaintext.fill(0); }
  } finally { secret.fill(0); }
}
export async function decryptVault(encoded: string, passphrase: string, binding: VaultBinding): Promise<unknown> {
  let secret: Buffer | undefined, plaintext: Buffer | undefined, partial: Buffer | undefined;
  try {
    if (Buffer.byteLength(encoded) > MAX_LOCAL_FILE_BYTES) throw new Error();
    const envelope = JSON.parse(encoded) as Envelope;
    if (envelope.schemaVersion !== 1 || !envelope.binding || bindingText(envelope.binding) !== bindingText(binding) || !/^[a-f0-9]{32}$/.test(envelope.salt) || !/^[a-f0-9]{24}$/.test(envelope.iv) || !/^[a-f0-9]{32}$/.test(envelope.tag) || typeof envelope.ciphertext !== "string" || !/^(?:[a-f0-9]{2})+$/.test(envelope.ciphertext)) throw new Error();
    secret = await key(passphrase, Buffer.from(envelope.salt, "hex"));
    const cipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(envelope.iv, "hex"));
    cipher.setAAD(Buffer.from(bindingText(binding)));
    cipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
    partial = cipher.update(Buffer.from(envelope.ciphertext, "hex"));
    plaintext = Buffer.concat([partial, cipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch { throw new CoordError("UNAUTHORIZED", "Vault unlock failed or binding differs"); }
  finally { secret?.fill(0); partial?.fill(0); plaintext?.fill(0); }
}
// File modes reduce accidental disclosure; they do not attest worker isolation or human presence.
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function checkStoreDirectory(path: string, create: boolean, privateStore = true): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    const parent = current; current = resolve(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      await syncDirectory(parent); stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoordError("UNAUTHORIZED", "Credential/configuration path must not follow symlinks");
  }
  const stat = await lstat(absolute);
  if (privateStore && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) throw new CoordError("UNAUTHORIZED", "Credential directory must be private to the operator account");
}
export async function writeNewPrivateFile(path: string, contents: string, privateStore = true): Promise<void> {
  if (Buffer.byteLength(contents) > MAX_LOCAL_FILE_BYTES) throw new CoordError("INVALID_INPUT", "Local file exceeds limit");
  await checkStoreDirectory(dirname(path), true, privateStore);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(contents, "utf8"); await file.sync(); } finally { await file.close(); }
  await syncDirectory(dirname(path));
}
export async function readSmallFile(path: string, privateStore = false): Promise<string> {
  await checkStoreDirectory(dirname(path), false, privateStore);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await readOpenedFile(file, privateStore); } finally { await file.close(); }
}
async function readOpenedFile(file: FileHandle, privateStore: boolean): Promise<string> {
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > MAX_LOCAL_FILE_BYTES || (privateStore && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) throw new CoordError("INVALID_INPUT", "Expected a bounded regular private local file");
  const bytes = Buffer.alloc(MAX_LOCAL_FILE_BYTES + 1);
  try {
    let length = 0;
    while (length <= MAX_LOCAL_FILE_BYTES) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length);
      if (!bytesRead) return bytes.subarray(0, length).toString("utf8");
      length += bytesRead;
    }
    throw new CoordError("INVALID_INPUT", "Local file exceeds limit");
  } finally { bytes.fill(0); }
}
export async function syncLocalFile(path: string, expectedDigest: string, privateStore = true): Promise<void> {
  await checkStoreDirectory(dirname(path), false, privateStore);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const contents = await readOpenedFile(file, privateStore);
    if (createHash("sha256").update(contents).digest("hex") !== expectedDigest) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Existing durable setup bytes differ");
    await file.sync();
  } finally { await file.close(); }
  for (let directory = resolve(dirname(path));;) {
    await syncDirectory(directory);
    const parent = dirname(directory); if (parent === directory) break;
    directory = parent;
  }
}
