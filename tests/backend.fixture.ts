import type { MutationCtx, Doc, TableName } from "../convex/server.js";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import type { DefaultFunctionArgs } from "convex/server";
// Transactional serialized fixture: tests real exported handlers, not Convex OCC/runtime.
// Index ordering, cursor sequencing and pagination here are a SIMULATION: an in-memory
// sort over a declared field list plus an offset cursor. They do not prove Convex runtime
// cursor validation or invalidation, real index behaviour, OCC or transaction contention.
// No deployment, host qualification or real two-client ownership claim is implied.
// Only the indexes declared below are ordered; any other index keeps insertion order.
const indexes: Record<string, string[]> = {
  "identityLinks.by_user_backend_generation": ["userId", "backendId", "generation"],
  "identityLinks.by_user_backend_revoked": ["userId", "backendId", "revokedAt"],
  "identityLinks.by_user_backend": ["userId", "backendId"],
  "mcpConnections.by_user": ["userId"],
};
const compare = (left: unknown, right: unknown): number => {
  if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? -1 : 1;
  if (typeof left === "number" && typeof right === "number") return left === right ? 0 : left < right ? -1 : 1;
  const a = String(left), b = String(right);
  return a === b ? 0 : a < b ? -1 : 1;
};
export class BackendFixture {
  rows = new Map<string, Record<string, unknown>>();
  serial = 0;
  // Additive read instrumentation only. Counting index reads changes no query behaviour,
  // ordering or result; it lets a test assert how many reads a handler performs and whether
  // it paginated at all. Reset it from the test before the call you want to measure.
  probe = { paginate: 0, take: [] as string[] };
  private tail: Promise<unknown> = Promise.resolve();
  context(): MutationCtx {
    const rows = this.rows;
    const db = {
      query(table: string) {
        const predicates: Array<(row: Record<string, unknown>) => boolean> = [];
        const number = (key: string, accept: (value: number) => boolean) => { predicates.push(row => typeof row[key] === "number" && accept(row[key] as number)); return q; };
        const q = { eq(key: string, value: unknown) { predicates.push(row => row[key] === value); return q; }, lte(key: string, value: number) { return number(key, candidate => candidate <= value); }, gte(key: string, value: number) { return number(key, candidate => candidate >= value); }, gt(key: string, value: number) { return number(key, candidate => candidate > value); } };
        let indexName: string | undefined, descending = false;
        const select = () => {
          const fields = indexName === undefined ? undefined : indexes[`${table}.${indexName}`];
          const found = [...rows.values()].filter(row => row._table === table && predicates.every(p => p(row)));
          if (fields) found.sort((left, right) => fields.reduce((order, field) => order || compare(left[field], right[field]), 0) || compare(left._creationTime, right._creationTime));
          if (descending) found.reverse();
          return found.map(({ _table: _omitted, ...row }) => structuredClone(row));
        };
        const query = { withIndex(name: string, build: (q: unknown) => unknown) { indexName = name; build(q); return query; }, order(direction: "asc" | "desc") { descending = direction === "desc"; return query; }, async unique() { const found = select(); if (found.length > 1) throw new Error("Duplicate unique index result"); return found[0] ?? null; }, async first() { return select()[0] ?? null; }, async take(n: number) { fixture.probe.take.push(table); return select().slice(0, n); }, async paginate(options: { cursor: string | null; numItems: number }) { fixture.probe.paginate++; const offset = options.cursor ? Number(options.cursor) : 0; const found = select(); return { page: found.slice(offset, offset + options.numItems), isDone: offset + options.numItems >= found.length, continueCursor: String(offset + options.numItems) }; } };
        return query;
      },
      async insert(table: string, document: Record<string, unknown>) { const id = `row_${++fixture.serial}`; rows.set(id, { ...structuredClone(document), _id: id, _creationTime: Date.now(), _table: table }); return id; },
      async patch(id: string, patch: Record<string, unknown>) { const old = rows.get(id); if (!old) throw new Error("Missing fixture row"); rows.set(id, { ...old, ...structuredClone(patch) }); },
      async replace(id: string, document: Record<string, unknown>) { const old = rows.get(id); if (!old) throw new Error("Missing fixture row"); rows.set(id, { ...structuredClone(document), _id: id, _creationTime: old._creationTime, _table: old._table }); },
      async get(id: string) { const row = rows.get(id); if (!row) return null; const { _table: _omitted, ...document } = row; return structuredClone(document); },
    };
    const fixture = this;
    return { db } as unknown as MutationCtx;
  }
  async call<A extends DefaultFunctionArgs, R>(fn: RegisteredMutation<"public" | "internal", A, R> | RegisteredQuery<"public" | "internal", A, R>, args: A): Promise<Awaited<R>> {
    const action = async () => {
      const before = structuredClone(this.rows);
      try { return await (fn as unknown as { _handler: (ctx: MutationCtx, args: A) => R })._handler(this.context(), args); }
      catch (error) { this.rows = before; throw error; }
    };
    const result = this.tail.then(action); this.tail = result.catch(() => undefined); return result as Promise<Awaited<R>>;
  }
  // Additive test-side row seeding for listing volume. No handler writes these rows and
  // they confer no authority; an explicit _creationTime keeps simulated index order exact.
  seed(table: TableName, document: Record<string, unknown>, creationTime = Date.now()): string {
    const id = `seed_${++this.serial}`;
    this.rows.set(id, { ...structuredClone(document), _id: id, _creationTime: creationTime, _table: table });
    return id;
  }
  find<T extends TableName>(table: T, id: string): Doc<T> {
    const result = [...this.rows.values()].find(row => row._table === table && row.id === id);
    if (!result) throw new Error(`Missing ${table} ${id}`);
    return structuredClone(result) as unknown as Doc<T>;
  }
}
