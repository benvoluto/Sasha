// In-memory fallback state (no POSTGRES_URL) must be one copy per server
// process. `next dev` can evaluate a module once per route bundle, so plain
// module-level Maps split: a document created through /api/documents was
// missing from /api/documents/[id]. Hanging the state off globalThis keeps one
// copy across bundles and hot reloads.

const registry = ((globalThis as { __sashaMemory?: Map<string, unknown> }).__sashaMemory ??= new Map());

/** The process-wide value for `name`, created by `init` on first use. */
export function processMemory<T>(name: string, init: () => T): T {
  if (!registry.has(name)) registry.set(name, init());
  return registry.get(name) as T;
}
