import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { CoordError, DEFAULTS } from "./protocol.js";

export const RULES_START = "<!-- COORD:MANAGED:RULES:START -->";
export const RULES_END = "<!-- COORD:MANAGED:RULES:END -->";
export interface ApprovedRules { policyVersion: number; content: string }
export interface RuleSyncResult { target: string; policyVersion: number; contentHash: string; changed: boolean }

function replaceBlock(existing: string, block: string): string {
  const starts = existing.split(RULES_START).length - 1;
  const ends = existing.split(RULES_END).length - 1;
  if (starts === 0 && ends === 0) return existing + (existing && !existing.endsWith("\n") ? "\n" : "") + block + "\n";
  const start = existing.indexOf(RULES_START);
  const end = existing.indexOf(RULES_END);
  if (starts !== 1 || ends !== 1 || start > end || (start > 0 && existing[start - 1] !== "\n") || (end + RULES_END.length < existing.length && !["\n", "\r"].includes(existing[end + RULES_END.length]!))) throw new CoordError("CONFLICT_UNRESOLVED", "Managed rules markers are ambiguous; preserve and repair the human file before syncing");
  return existing.slice(0, start) + block + existing.slice(end + RULES_END.length);
}

/** Caller supplies the backend's current approved policy; this helper never grants approval. */
export async function syncRules(root: string, targets: readonly string[], rules: ApprovedRules): Promise<RuleSyncResult[]> {
  if (!Number.isSafeInteger(rules.policyVersion) || rules.policyVersion < 1 || typeof rules.content !== "string" || rules.content.includes(RULES_START) || rules.content.includes(RULES_END) || rules.content.includes("\0")) throw new CoordError("INVALID_INPUT", "Approved rules require a positive policy version and marker-free text");
  const canonicalRoot = await realpath(root);
  const seen = new Set<string>();
  const prepared: { target: string; filename: string; original: Buffer | undefined; mode: number; next: string }[] = [];
  const block = `${RULES_START}\n<!-- policyVersion: ${rules.policyVersion} -->\n${rules.content}${rules.content.endsWith("\n") ? "" : "\n"}${RULES_END}`;
  for (const target of targets) {
    if (!target || path.isAbsolute(target) || path.win32.isAbsolute(target) || target.includes("\\") || target.includes("\0") || target.split("/").some(p => !p || p === "." || p === ".." || p === ".git")) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Rule targets must be ordinary repository-relative paths");
    if (seen.has(target)) throw new CoordError("INVALID_INPUT", "Duplicate rule sync target");
    seen.add(target);
    const pieces = target.split("/");
    let parent = canonicalRoot;
    for (const piece of pieces.slice(0, -1)) {
      parent = path.join(parent, piece);
      const stat = await lstat(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Rule target parents must be existing ordinary directories");
    }
    const filename = path.join(parent, pieces.at(-1)!);
    let original: Buffer | undefined;
    let mode = 0o644;
    try {
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > DEFAULTS.fileBytes) throw new CoordError("INVALID_INPUT", "Rule target must be a bounded regular file");
        mode = stat.mode & 0o777;
        original = await handle.readFile();
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Rule targets cannot be symlinks");
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let existing: string;
    try { existing = new TextDecoder("utf-8", { fatal: true }).decode(original ?? Buffer.alloc(0)); }
    catch { throw new CoordError("INVALID_INPUT", "Rule target must contain valid UTF-8 text"); }
    const next = replaceBlock(existing, block);
    if (Buffer.byteLength(next, "utf8") > DEFAULTS.fileBytes) throw new CoordError("INVALID_INPUT", "Synchronized rule file exceeds the byte limit");
    prepared.push({ target, filename, original, mode, next });
  }
  const results: RuleSyncResult[] = [];
  for (const file of prepared) {
    const contentHash = createHash("sha256").update(file.next).digest("hex");
    const changed = !file.original?.equals(Buffer.from(file.next));
    if (changed) {
      // Resolve again before writing; ordinary symlinks are refused rather than followed.
      if (await realpath(path.dirname(file.filename)) !== path.dirname(file.filename)) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Rule target directory changed during sync");
      const temporary = path.join(path.dirname(file.filename), `.coord-rules-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, "wx", file.mode);
        try { await handle.writeFile(file.next, "utf8"); await handle.chmod(file.mode); await handle.sync(); }
        finally { await handle.close(); }
        let current: Buffer | undefined;
        try {
          const handle = await open(file.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
          try { current = await handle.readFile(); } finally { await handle.close(); }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CoordError("CONFLICT_UNRESOLVED", "Rule target changed during sync");
        }
        if ((file.original === undefined) !== (current === undefined) || (file.original && !file.original.equals(current!))) throw new CoordError("CONFLICT_UNRESOLVED", "Human rule edits changed during sync; retry from current content");
        await rename(temporary, file.filename);
      } finally { await rm(temporary, { force: true }); }
    }
    results.push({ target: file.target, policyVersion: rules.policyVersion, contentHash, changed });
  }
  return results;
}
