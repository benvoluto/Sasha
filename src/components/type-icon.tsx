// A document type's icon in its colour (redesign3-spec.md §5): the overview
// cards, the editor title, the Outline panel's type picker and the Doc Gallery.
// Catalog files name their icon in lucide's vocabulary (src/catalog/schema.ts
// TYPE_ICONS); this table maps each name to the Phosphor icon the app renders.
// An untyped document shows a dashed page in grey.
//
// CONTRACT (redesign 3 foundation): shared by every track; change it only by
// adding names to ICONS alongside TYPE_ICONS.

import {
  Airplane, ArrowsClockwise, Atom, Backpack, BookBookmark, Books, Brain, Briefcase, CalendarBlank, ChartLine, ChartScatter,
  ChatsCircle, ClipboardText, Code, Coffee, Compass, EnvelopeSimple, FileCode, FileDashed, FileText, Flag, Flask, Globe,
  GraduationCap, HandCoins, Heart, IdentificationCard, Lightbulb, ListChecks, Microscope, PencilSimple, Scales, Siren, Star,
  TrendUp, Users, Wrench, type Icon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { TypeColor, TypeIcon as TypeIconName } from "@/catalog/schema";

const ICONS: Record<TypeIconName, Icon> = {
  atom: Atom,
  backpack: Backpack,
  "book-marked": BookBookmark,
  brain: Brain,
  briefcase: Briefcase,
  calendar: CalendarBlank,
  "chart-line": ChartLine,
  "chart-scatter": ChartScatter,
  "clipboard-list": ClipboardText,
  "code-xml": Code,
  coffee: Coffee,
  compass: Compass,
  "file-code": FileCode,
  "file-text": FileText,
  flag: Flag,
  "flask-conical": Flask,
  globe: Globe,
  "graduation-cap": GraduationCap,
  "hand-coins": HandCoins,
  heart: Heart,
  "id-card": IdentificationCard,
  library: Books,
  lightbulb: Lightbulb,
  "list-checks": ListChecks,
  mail: EnvelopeSimple,
  "messages-square": ChatsCircle,
  microscope: Microscope,
  pencil: PencilSimple,
  plane: Airplane,
  "refresh-cw": ArrowsClockwise,
  scale: Scales,
  siren: Siren,
  star: Star,
  "trending-up": TrendUp,
  users: Users,
  wrench: Wrench,
};

/** The CSS colour for a type colour name (a --type-<name> token; --type-untyped when there is none). */
export function typeColorVar(color: TypeColor | null | undefined): string {
  return `var(--type-${color ?? "untyped"})`;
}

type Props = {
  /** The type's icon (DocumentTypeSummary.icon); null or undefined for an untyped document. */
  icon?: TypeIconName | null;
  color?: TypeColor | null;
  className?: string;
  /** Accessible name; omitted, the icon is decorative (the type's name is beside it). */
  label?: string;
};

export function TypeIcon({ icon, color, className, label }: Props) {
  const Glyph = icon ? ICONS[icon] : FileDashed;
  return (
    <Glyph
      className={cn("h-6 w-6 shrink-0", className)}
      style={{ color: typeColorVar(icon ? color : null) }}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}
