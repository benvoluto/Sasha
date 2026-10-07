import { NextRequest, NextResponse } from "next/server";
import { fetchGroupMetadata } from "@/lib/ontology/group-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IDS = 20;

type Status = {
  id: string;
  status: "processing" | "completed" | "error" | "partial" | "unknown";
  fileCount: number;
  name?: string;
  error?: string;
  processedAt?: string;
};

/**
 * GET /api/upload-groups/status?ids=a,b,c
 *
 * The minimum needed to answer "is this upload still working?" — one small blob
 * read per group, no extracted text. Exists so the processing tracker can poll
 * without pulling whole records.
 */
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (ids.length === 0) return NextResponse.json({ statuses: [] });

  const statuses: Status[] = await Promise.all(
    ids.map(async (id): Promise<Status> => {
      try {
        const meta = (await fetchGroupMetadata(id)) as
          | ({ files?: Array<{ name?: string }>; geminiProcessing?: { status?: string; error?: string; processedAt?: string } })
          | null;
        // A missing record means the group was deleted — treat as resolved so a
        // tracked job can't hang forever.
        if (!meta) return { id, status: "unknown", fileCount: 0 };
        const s = meta.geminiProcessing?.status;
        return {
          id,
          status: s === "processing" || s === "completed" || s === "error" || s === "partial" ? s : "unknown",
          fileCount: Array.isArray(meta.files) ? meta.files.length : 0,
          name: Array.isArray(meta.files) ? meta.files[0]?.name : undefined,
          error: meta.geminiProcessing?.error,
          processedAt: meta.geminiProcessing?.processedAt,
        };
      } catch {
        return { id, status: "unknown", fileCount: 0 };
      }
    }),
  );

  return NextResponse.json({ statuses }, { headers: { "Cache-Control": "no-store" } });
}
