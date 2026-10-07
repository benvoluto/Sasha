import { DocumentScreen } from "@/components/editor/document-screen";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentScreen key={id} documentId={id} />;
}
