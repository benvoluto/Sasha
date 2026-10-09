// The section keys a learned workflow's steps name, checked against its type.
// Split out of validate.ts so the review screen can re-run this one rule after
// the author edits the type, without loading the catalog's workflows.
//
// Pure and client-safe.

const SECTION_KEY_FIELDS = ["specKeys", "sectionKeys", "fromSpecKeys", "toSpecKeys", "appliesTo"];

/** Section keys named anywhere in a step's settings. */
export function sectionKeysIn(config: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key = "") => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
    else if (typeof v === "string" && SECTION_KEY_FIELDS.includes(key)) out.push(v);
  };
  walk(config);
  return out;
}

const SUFFIX = "is not one of the type's section keys";

/** One error per section key a step names that the type doesn't have. */
export function sectionKeyErrors(steps: ReadonlyArray<{ id: string; config?: unknown }>, sections: ReadonlyArray<{ key: string }>): string[] {
  const keys = new Set(sections.map((s) => s.key));
  return steps.flatMap((s) => sectionKeysIn(s.config).filter((k) => !keys.has(k)).map((k) => `steps.${s.id}.config: "${k}" ${SUFFIX}`));
}

/** Is this workflow error the section-key rule's (so a type edit can clear it)? */
export const isSectionKeyError = (e: string) => e.endsWith(SUFFIX);
