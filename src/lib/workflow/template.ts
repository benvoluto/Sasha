// {{name}} templates for prompts and Combine text.

const VAR = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** Variable names a template references. */
export function templateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(VAR)].map((m) => m[1]))];
}

/** A value as prompt text: strings as-is, lists one per line, anything else as JSON. */
export function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? `- ${v}` : JSON.stringify(v))).join("\n");
  return JSON.stringify(value, null, 2);
}

export function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(VAR, (whole, name: string) => (name in values ? asText(values[name]) : whole));
}
