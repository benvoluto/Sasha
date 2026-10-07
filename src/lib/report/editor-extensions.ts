// The single Tiptap extension set the report editor uses. Its node/mark schema
// matches what the markdown→ProseMirror converter emits (StarterKit names), so
// generated content loads with nothing dropped. Client-only.

import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import type { Extensions } from "@tiptap/react";

export const reportExtensions: Extensions = [
  StarterKit,
  Underline,
  Link.configure({ openOnClick: false, autolink: true }),
  TextAlign.configure({ types: ["heading", "paragraph"] }),
  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,
  // Block images, including baked charts (data: URI SVG).
  Image.configure({ inline: false, allowBase64: true }),
  Placeholder.configure({ placeholder: "Write or generate this section…" }),
];
