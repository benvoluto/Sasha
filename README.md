# Sasha

A general document-authoring app. It opens to a blank document, keeps a
switchable list of documents, treats uploads as a shared **source library**,
extracts tabular **data**, and uses a catalog of **document types** (outlines
and rubrics) to scaffold, classify, check and restructure writing.

Sasha started as a pruned copy of `benvoluto/proto-v2-organizer`. See
[`docs/PLAN.md`](docs/PLAN.md) for the evaluation and the phased plan.

## Status

Phases 0–7 are built: the blank-document editor with autosave, versions and
Claude model routing; the team-scoped source library (folders, uploads, URL
and note sources, extraction, summaries and passages); and the document-type
catalog with outlines, the living outline and per-section drafting tools; the
editor layout (docs panel, document folders, floating Outline/Tools/Sources);
and Phase 4: document notes with dictation, the type classifier with an
apply-outline chip, and source and data suggestions; and Phase 5: data tables
from CSV, XLSX and PDF sources, a Data tab and Insert table; and Phase 6:
workflows (source coverage, restructure, draft all, and a workflow per document
type); and Phase 7: verified citations, the rubric check and Markdown, Word and
PDF export. Next is Phase 8, the rest of the catalog and learning from an example.
Per-type workflow specs for Phase 6 are in
`docs/workflows-by-document-type.md`. See
`docs/PLAN.md` §12.

## Stack

- Next.js 15 (App Router) on Vercel, Node 24
- Clerk (Organizations for team-wide sharing)
- Vercel Blob for uploads; Neon Postgres for documents, workflows and the audit log
- Gemini for reading uploads; Claude (Haiku, Sonnet, Opus) for classification,
  suggestions, checks and drafting
- TipTap editor, React Flow workflow canvas, jotai, zod, vitest

## Local development

```bash
npm install
cp .env.example .env.local   # or ./setup-local-env.sh to pull from Vercel
npm run dev
```

Set `POSTGRES_URL` and run `POST /api/ontology/setup` (or
`psql "$POSTGRES_URL" -f db/schema.sql`) once to create the tables.

## Checks

```bash
npm run lint
npm run typecheck
npm test
```
