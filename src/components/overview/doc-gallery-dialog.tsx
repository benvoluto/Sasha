"use client";

// The overview's Doc Gallery (redesign3-spec.md §8): every document type the
// team can use; picking one creates a document of that type (the server builds
// its outline) and opens it. Opened inside a folder, the new document is filed
// there first. Errors show inline in the dialog; focus returns to the Doc
// Gallery button when it closes (TypeGallery records the opener).

import { useRouter } from "next/navigation";
import { createDocumentOfType, TypeGallery, useDocumentTypes } from "@/components/editor/type-picker";
import { patchDocument } from "@/components/shell/doc-folders-api";
import { errorMessage } from "./overview-model";

export function DocGalleryDialog({ open, onOpenChange, folderId }: { open: boolean; onOpenChange: (open: boolean) => void; /** The open folder, or null at the top level. */ folderId: string | null }) {
  const router = useRouter();
  const catalog = useDocumentTypes();
  return (
    <TypeGallery
      open={open}
      onOpenChange={onOpenChange}
      types={catalog.types}
      loading={catalog.loading}
      error={catalog.error}
      title="Doc Gallery"
      description="Pick a type to start a document with its outline. Each type tells Claude how to write each section."
      onChoose={async (t) => {
        try {
          const id = await createDocumentOfType(t.key);
          // A failed move still opens the new document (it just lands at the top level).
          if (folderId) await patchDocument(id, { doc_folder_id: folderId }).catch(() => undefined);
          router.push(`/d/${id}`);
        } catch (e) {
          return errorMessage(e, "Couldn't create the document.");
        }
      }}
    />
  );
}
