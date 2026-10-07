// Describes the assistant's tools in its system prompt, filtered to what this
// caller may use. The assistant only reads; it has no write tools.

import { ASSISTANT_TOOLS } from "./tools";
import { can, type Auth } from "../governance";

export function renderMenu(auth: Auth): string {
  const tools = Object.values(ASSISTANT_TOOLS).filter((t) => can(auth, t.permission));
  if (tools.length === 0) return "# Tools\n  (you have no read access to this document's sources)";
  const lines = ["# Tools you can call for this document (nothing else)"];
  for (const t of tools) {
    const params = Object.keys(t.params);
    lines.push(`  - ${t.name}(${params.join(", ")}): ${t.description}`);
  }
  return lines.join("\n");
}
