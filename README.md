# Sasha

A general document-authoring app. It opens to a blank document, keeps a
switchable list of documents, treats uploads as a shared **source library**,
extracts tabular **data**, and uses a catalog of **document types** (outlines
and rubrics) to scaffold, classify, check and restructure writing.

Sasha started as a pruned copy of `benvoluto/proto-v2-organizer`. See
[`docs/PLAN.md`](docs/PLAN.md) for the evaluation and the phased plan.

## Status

Phase 0 (bootstrap): clinical modules removed; upload, extraction, report
editor and workflow canvas kept and made domain-neutral. Upload groups still
stand in for documents until Phase 1 introduces the Postgres `document` model.

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
