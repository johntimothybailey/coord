import { spawn } from "node:child_process";
import { CoordError } from "./protocol.js";
import type { ReviewHostAdapter, ReviewLookup, ReviewRecord } from "./review.js";

type Request = (args: string[], input?: string) => Promise<unknown>;
function ghRequest(environment: NodeJS.ProcessEnv): Request {
  return (args, input) => new Promise((resolve, reject) => {
    const child = spawn("gh", ["api", "--hostname", "github.com", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", ...args], { env: environment, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let bytes = 0, failed = false;
    let fallback: NodeJS.Timeout | undefined;
    const fail = () => {
      failed = true;
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Completion remains uncertain. */ }
      fallback ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); reject(new CoordError("PUBLICATION_STALE", "GitHub request timed out; reconcile before retry")); }, 250);
    };
    const timer = setTimeout(fail, 30_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) fail(); else chunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) fail(); });
    child.stdin.on("error", () => {});
    child.once("error", () => { clearTimeout(timer); reject(new CoordError("PUBLICATION_STALE", "Selected GitHub adapter unavailable; output withheld")); });
    child.once("close", code => {
      clearTimeout(timer); if (fallback) clearTimeout(fallback);
      if (failed || code !== 0) { reject(new CoordError("PUBLICATION_STALE", "GitHub request is incomplete or uncertain; reconcile before retry")); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); } catch { reject(new CoordError("PUBLICATION_STALE", "GitHub returned invalid structured data")); }
    });
    child.stdin.end(input);
  });
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new CoordError("PUBLICATION_STALE", "Invalid GitHub record"); return value as Record<string, unknown>; }

/** Trusted verifier-side adapter. Provider access itself must pass native permission qualification. */
export class GitHubReviewAdapter implements ReviewHostAdapter {
  private readonly slug: string;
  private readonly request: Request;
  constructor(readonly repositoryId: string, environment: NodeJS.ProcessEnv, request?: Request) {
    if (!/^github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repositoryId)) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "GitHub adapter requires the selected canonical repository");
    this.slug = repositoryId.slice("github.com/".length); this.request = request ?? ghRequest(environment);
  }
  private lookup(input: ReviewLookup): void {
    if (input.repositoryId !== this.repositoryId || !/^[A-Za-z0-9_-]{1,100}$/.test(input.publicationId) || !/^coord\/reviews\/[A-Za-z0-9_-]+\/e[1-9][0-9]*\/[A-Za-z0-9_-]+$/.test(input.headRef) || !input.headRef.endsWith(`/${input.publicationId}`) || !input.baseRef || /[\x00-\x20~^:?*\[\\]/.test(input.baseRef)) throw new CoordError("FORBIDDEN", "PR operation differs from selected immutable publication routing");
  }
  private record(raw: unknown): ReviewRecord {
    const value = object(raw), head = object(value.head), base = object(value.base);
    const number = value.number, url = value.html_url;
    const body = typeof value.body === "string" ? value.body : "";
    const matches = [...body.matchAll(/^Coord publication: ([A-Za-z0-9_-]{1,100})$/gm)];
    if (!Number.isSafeInteger(number) || Number(number) < 1 || typeof url !== "string" || url !== `https://github.com/${this.slug}/pull/${number}` || object(head.repo).full_name !== this.slug || object(base.repo).full_name !== this.slug || typeof head.ref !== "string" || typeof base.ref !== "string" || typeof head.sha !== "string" || typeof base.sha !== "string" || ![head.sha, base.sha].every(sha => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) || !["open", "closed"].includes(String(value.state)) || matches.length !== 1) throw new CoordError("PUBLICATION_STALE", "PR readback does not identify one selected repository/publication");
    return { id: String(number), url, state: value.merged_at ? "merged" : value.state as "open" | "closed", repositoryId: this.repositoryId, publicationId: matches[0]![1]!, headRef: head.ref, headSha: head.sha, baseRef: base.ref, baseSha: base.sha };
  }
  async find(input: ReviewLookup): Promise<ReviewRecord[]> {
    this.lookup(input);
    const query = new URLSearchParams({ state: "all", head: `${this.slug.split("/")[0]}:${input.headRef}`, base: input.baseRef, per_page: "100" });
    const pages = await this.request([`repos/${this.slug}/pulls?${query}`, "--method", "GET", "--paginate", "--slurp"]);
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new CoordError("COVERAGE_INCOMPLETE", "GitHub PR pagination is incomplete");
    // A conflicting PR on the same immutable branch is an error, never grounds for blind duplication.
    return pages.flat().map(value => this.record(value));
  }
  async create(input: ReviewLookup & { headSha: string; baseSha: string; title: string; body: string }): Promise<ReviewRecord> {
    this.lookup(input);
    if (!input.body.split("\n").includes(`Coord publication: ${input.publicationId}`)) throw new CoordError("INVALID_INPUT", "PR body must bind its publication identity");
    return this.record(await this.request([`repos/${this.slug}/pulls`, "--method", "POST", "--input", "-"], JSON.stringify({ head: input.headRef, base: input.baseRef, title: input.title, body: input.body, maintainer_can_modify: false })));
  }
  async read(id: string): Promise<ReviewRecord> {
    if (!/^[1-9][0-9]{0,15}$/.test(id)) throw new CoordError("INVALID_INPUT", "Invalid GitHub PR number");
    return this.record(await this.request([`repos/${this.slug}/pulls/${id}`, "--method", "GET"]));
  }
}
