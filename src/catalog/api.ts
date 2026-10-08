// Helpers shared by the /api/document-types routes: zod issues as readable
// lines (the admin page shows them inline) and the 400 response.

import { NextResponse } from "next/server";
import type { z } from "zod";

/** `path: message` per issue, with the request wrapper ("definition.") dropped from the path. */
export function issueLines(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = (i.path[0] === "definition" ? i.path.slice(1) : i.path).join(".");
    return `${path || "(root)"}: ${i.message}`;
  });
}

export function invalidDefinition(issues: string[]): NextResponse {
  return NextResponse.json({ error: issues[0] ? `The document type is not valid: ${issues[0]}` : "The document type is not valid.", issues }, { status: 400 });
}
