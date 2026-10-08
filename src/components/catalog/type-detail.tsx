"use client";

// Read-only view of one document type on the /catalog page: what it is for,
// how the model writes it, every section with its guidance and tracked
// elements, the rubric (universal criteria plus the type's own) and where the
// structure came from.

import { ExternalLink } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import type { DocumentTypeDefinition } from "@/catalog/schema";
import { rubricFor, UNIVERSAL_RUBRIC_KEYS } from "@/catalog/universal-rubric";

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">{label}</h3>
      <div className="text-sm leading-relaxed">{children}</div>
    </section>
  );
}

function Items({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="text-xs font-medium text-[var(--doc-muted)]">{label}</div>
      <ul className="ml-4 list-disc text-sm">
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

export function TypeDetail({ type }: { type: DocumentTypeDefinition }) {
  const ownKeys = new Set(type.rubric.map((c) => c.key));
  const rubric = rubricFor(type);
  return (
    <div className="space-y-6">
      <Block label="Summary">{type.summary}</Block>
      <div className="grid gap-4 sm:grid-cols-2">
        <Block label="Audience">{type.audience}</Block>
        <Block label="Tone">{type.tone}</Block>
      </div>
      <Block label="How Claude writes it">
        <p className="whitespace-pre-wrap">{type.preamble}</p>
      </Block>

      <Block label={`Sections (${type.sections.length})`}>
        <ol className="space-y-3">
          {type.sections.map((s) => (
            <li key={s.key} className="rounded-lg border border-[var(--doc-line)] p-3" style={{ marginLeft: s.level === 3 ? 16 : 0 }}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.heading}</span>
                <Badge variant="outline">H{s.level}</Badge>
                {!s.required && <Badge variant="secondary">Optional</Badge>}
                {s.renderer !== "narrative" && <Badge variant="secondary">{s.renderer === "static" ? "Fixed text" : s.renderer}</Badge>}
                {s.lengthHint && <span className="text-xs text-[var(--doc-muted)]">{s.lengthHint}</span>}
              </div>
              <p className="mt-1.5 text-sm text-[var(--doc-muted)]">{s.guidance}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <Items label="Elements" items={s.elements} />
                <Items label="Sources needed" items={s.sourcesNeeded} />
                <Items label="Data needed" items={s.dataNeeded} />
              </div>
              {s.scaffold && <pre className="mt-2 whitespace-pre-wrap rounded bg-[var(--doc-accent-soft)] p-2 text-xs">{s.scaffold}</pre>}
            </li>
          ))}
        </ol>
      </Block>

      <Block label="Rubric">
        <ul className="space-y-2">
          {rubric.map((c) => (
            <li key={c.key}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.criterion}</span>
                <Badge variant={ownKeys.has(c.key) ? "default" : "outline"}>
                  {ownKeys.has(c.key) ? (UNIVERSAL_RUBRIC_KEYS.has(c.key) ? "This type (replaces universal)" : "This type") : "Universal"}
                </Badge>
              </div>
              {c.appliesTo && <div className="text-xs text-[var(--doc-muted)]">Applies to: {c.appliesTo.join(", ")}</div>}
              <ul className="mt-1 space-y-0.5 text-xs text-[var(--doc-muted)]">
                {c.levels.map((l) => (
                  <li key={l.score}>
                    <span className="font-semibold">{l.score}</span> — {l.descriptor}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Block>

      <Block label="Provenance">
        <p>
          {type.provenance.source} · {type.provenance.license} · read {type.provenance.retrieved}
        </p>
        {type.provenance.url && (
          <a href={type.provenance.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--doc-accent)] hover:underline">
            {type.provenance.url} <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        {type.aliases.length > 0 && <p className="text-xs text-[var(--doc-muted)]">Also answers to: {type.aliases.join(", ")}</p>}
      </Block>
    </div>
  );
}
