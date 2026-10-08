import type { Metadata } from "next";
import { CatalogAdmin } from "@/components/catalog/catalog-admin";

export const metadata: Metadata = { title: "Document types · Sasha" };

/** /catalog — browse the team's document types; team admins enable, edit and create them. */
export default function CatalogPage() {
  return <CatalogAdmin />;
}
