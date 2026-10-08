// The access level every blob write uses. It has to match the store: a private
// store rejects public writes ("Cannot use public access on a private store")
// and a public store rejects private ones. Private is the default because the
// app never hands out blob URLs (files are served through the team-checked
// /api/sources/[id]/file route, and server reads carry the store token; see
// blob-host.ts). Set BLOB_ACCESS=public for a store created as public.

export type BlobAccess = "public" | "private";

export function blobAccess(env: Record<string, string | undefined> = process.env): BlobAccess {
  return env.BLOB_ACCESS?.trim().toLowerCase() === "public" ? "public" : "private";
}
