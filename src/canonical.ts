/** Canonical JSON shared across Node and Convex; sorted UTF-16 keys, no locale dependence. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Nonfinite JSON number");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("Expected a plain JSON object");
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const result = JSON.stringify(value); if (result === undefined) throw new Error("Expected JSON data"); return result;
}
