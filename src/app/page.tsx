import { DocumentScreen } from "@/components/editor/document-screen";

// The app opens on a blank document. "New" in the document switcher links here
// with a fresh `n`, which remounts the editor for another new document.
export default async function Home({ searchParams }: { searchParams: Promise<{ n?: string }> }) {
  const { n } = await searchParams;
  return <DocumentScreen key={n ?? "home"} documentId={null} />;
}
