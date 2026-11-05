import type { MutationCtx, Doc, TableName } from "../convex/server.js";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import type { DefaultFunctionArgs } from "convex/server";
// Transactional serialized fixture: tests real exported handlers, not Convex OCC/runtime.
// No deployment, host qualification or real two-client ownership claim is implied.
export class BackendFixture {
  rows = new Map<string, Record<string, unknown>>();
  serial = 0;
  private tail: Promise<unknown> = Promise.resolve();
  context(): MutationCtx {
    const rows = this.rows;
    const db = {
      query(table: string) {
        const predicates: Array<(row: Record<string, unknown>) => boolean> = [];
        const q = { eq(key: string, value: unknown) { predicates.push(row => row[key] === value); return q; }, lte(key: string, value: number) { predicates.push(row => typeof row[key] === "number" && (row[key] as number) <= value); return q; } };
        const select = () => [...rows.values()].filter(row => row._table === table && predicates.every(p => p(row))).map(({ _table: _omitted, ...row }) => structuredClone(row));
        const query = { withIndex(_name: string, build: (q: unknown) => unknown) { build(q); return query; }, async unique() { const found = select(); if (found.length > 1) throw new Error("Duplicate unique index result"); return found[0] ?? null; }, async first() { return select()[0] ?? null; }, async take(n: number) { return select().slice(0, n); }, async paginate(options: { cursor: string | null; numItems: number }) { const offset = options.cursor ? Number(options.cursor) : 0; const found = select(); return { page: found.slice(offset, offset + options.numItems), isDone: offset + options.numItems >= found.length, continueCursor: String(offset + options.numItems) }; } };
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
  find<T extends TableName>(table: T, id: string): Doc<T> {
    const result = [...this.rows.values()].find(row => row._table === table && row.id === id);
    if (!result) throw new Error(`Missing ${table} ${id}`);
    return structuredClone(result) as unknown as Doc<T>;
  }
}
