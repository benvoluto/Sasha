import { DocumentScreen } from "@/components/editor/document-screen";

// A new blank document (redesign3-spec.md §1). Nothing is stored until the
// first edit; the editor then swaps the address for /d/<id> (use-document.ts).
// "New" on the overview links here with a fresh `n`, which remounts the editor
// when one new document is already open.
export default async function NewDocumentPage({ searchParams }: { searchParams: Promise<{ n?: string }> }) {
  const { n } = await searchParams;
  return <DocumentScreen key={n ?? "new"} documentId={null} />;
}
