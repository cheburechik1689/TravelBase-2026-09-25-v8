export function asJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function newId(prefix = "") {
  const id = crypto.randomUUID().replace(/-/g, "");
  return prefix ? `${prefix}_${id.slice(0, 16)}` : id.slice(0, 16);
}
