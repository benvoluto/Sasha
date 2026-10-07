import { NextResponse } from "next/server";
import { DOCUMENT_TYPES } from "@/lib/documents/types";

/** GET /api/document-types — the types offered in the editor's type picker. */
export async function GET() {
  return NextResponse.json({ types: DOCUMENT_TYPES });
}
