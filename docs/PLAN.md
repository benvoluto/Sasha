# Sasha: viability evaluation and implementation plan

Sasha is a general document-authoring app derived from `benvoluto/proto-v2-organizer`
(the "Proto V2 organizer" clinical case manager). It opens to a blank document,
keeps a switchable list of documents, treats uploaded material as a shared
**source library**, extracts tabular **data**, and uses a catalog of **document
types** (outlines plus rubrics) to scaffold, classify, check and restructure
writing.

Status (October 2026): Phases 0–8 and the editor layout are built. See §12 for progress notes.

---

## 1. Verdict

**Viability: high.** About 65% of the organizer's `src/` (about 31k lines) carries
over unchanged or with mechanical renaming. The pieces that are hard to build are
already there and tested: upload, Gemini extraction, TipTap ↔ markdown conversion,
the workflow canvas and engine, suggestion editing, audit logging, and the patterns
for quoting and verifying source passages. The new work is product logic: the
document-type catalog, the single-document editor model, the classifier,
suggestions, generic data, and the new workflows.

| Bucket | Lines (approx.) | Share | Examples |
|---|---|---|---|
| Reuse as-is | 9,240 | 30% | shadcn UI, Clerk auth, Blob upload/presign, Gemini extraction helpers, `markdown-to-tiptap`, workflow `validate`/`edge-routing`/`run-stats`, `text-match`, `passages`, `governance` |
| Adapt (rename/generalize) | 10,920 | 35% | upload routes, document list (was case list), document modal (was case modal), `report-editor`, `report/service`, workflow `engine`/`registry`/canvas, suggestion list, assistant agent loop |
| Rewrite | 2,010 | 6% | template → document-type definition, catalog, suggestion generation, assessment → data, default workflow graph |
| Drop | 8,820 | 29% | eligibility, exclusion and determination cores, `prompt-defaults.ts` (2,197 lines), approvals, debug routes, Edge Config prompt settings |

Keeping the FIE (Full and Individual Evaluation) as a document type moves some
only its outline and drafting guidance into the catalog (decided: outline only).

**Rough effort:** 40–54 developer-days for one developer working with Claude Code,
across nine phases. The first usable build, a blank editor with document types,
sources and notes, comes after Phases 0–4 (about 20–25 days).

---

## 2. Decisions recorded

| # | Decision |
|---|---|
| 1 | Start from a pruned copy of the organizer, with fresh git history |
| 2 | Keep the FIE as one document type (outline and guidance only) |
| 3 | Small team, shared team-wide through Clerk Organizations; keep the audit log; drop the formal approval steps |
| 4 | One continuous TipTap document; AI actions for each section are attached to its heading |
| 5 | One shared source library organized in folders. Each document gets its own folder, and any source can be linked into any document |
| 6 | "Data" means any tabular data parsed from PDF, CSV or XLSX. Charts come later |
| 7 | Rubrics both shape the outline and score the draft on demand |
| 8 | Export to DOCX, PDF and Markdown |
| 9 | Catalog built from hand-curated, high-quality sources. ClawHub is used only for individual useful types and is not monitored on a schedule |
| 10 | The classifier runs after a 5 s pause once at least 150 words have changed (or the notes change), at most every 2 minutes, and shows a quiet chip |
| 11 | Generic workflow: score how well sources cover the document type, flag missing sources and data, and propose public web resources. A "restructure to another type" workflow is also needed |
| 12 | Model mix: Gemini only for reading uploads (PDF/image text and tables, OCR), Claude Haiku/Sonnet for the classifier and cheaper calls, Claude Opus for drafting. Sending drafts to model providers is acceptable |
| 13 | New, separate Vercel, Neon and Clerk projects |
| 14 | Deliverables: this file plus a shareable page |
| 15–18 | Notes: live dictation into a single running scratchpad in the document modal, as in deskapp. Audio is always discarded. Each section in the editor has a notes area with dictation and a "Draft from notes" or "Rewrite from notes" action |

Also in scope: the living outline, source citations, and type switching through a
restructure workflow.

---

## 3. How the concepts map

| Organizer | Sasha |
|---|---|
| Case (Blob `upload-groups/{id}/metadata.json`) | **Document**, a Postgres row |
| Case list (home page) | **Document list**, a switcher. The home page is a blank new document |
| Case modal (`case-detail-view.tsx`) | **Document modal**: notes, sources, data, suggestions, outline, workflows |
| Case documents (referral packet) | **Sources**: a shared library in folders, linked to documents |
| Assessments (`assessment_result`, psychometric scores) | **Data**: extracted tables with typed columns |
| FIE report (`report` + `report_section` rows) | **Document body**, one ProseMirror JSON tree plus per-section metadata |
| `FIE_TEMPLATE` | One **document type** in the catalog |
| Suggested documents and assessments (clinical rules) | **Suggested sources and data** (type checklist plus notes plus an LLM) |
| Summary note (sticky note) | **Notes scratchpad** (dictation, feeds the classifier) |
| Determination workflow (reviewers → agreement → supervisor) | **Workflows**: source coverage, restructure, user-authored |
| Case Assistant | **Document assistant** (same agent loop, new tools) |

---

## 4. Architecture

### 4.1 Stack (unchanged unless noted)
- Next.js 15 App Router on Vercel (Node 24), Clerk, Vercel Blob, Neon Postgres, jotai,
  TipTap 2.27, `@xyflow/react`, zod 4, vitest.
- **New:** `@anthropic-ai/sdk` (Claude, used directly so prompt caching, the web
  search tool and citations are available), `docx` (DOCX export), `xlsx`/SheetJS
  and `papaparse` (tabular parsing), PDF export (see Phase 7).
- **Removed:** `@vercel/edge-config`, `@vercel/postgres` (deprecated; move to
  `@neondatabase/serverless`), `import` (an accidental dependency in the organizer).

### 4.2 Model routing (`src/lib/llm/`)
Every model call goes through one module, `llm.ts`, which grows out of
`agent-determination/llm.ts`. Each call is tagged with a **task**; a config table
maps the task to a provider and model, and environment variables can override it.

| Task | Default model | Why |
|---|---|---|
| `classify.type` (background classifier) | Claude Haiku 5.5 | Cheap and fast. The catalog summaries sit in a cached system prompt |
| `suggest.sources`, `suggest.data`, `outline.status`, `title`, `summarize.source` | Claude Haiku 5.5 | Short, structured JSON output |
| `rubric.check`, `coverage.score`, `restructure.plan`, `assistant` | Claude Sonnet | Needs reasoning across sources and rubric criteria |
| `draft.section`, `rewrite.section`, `draft.from_notes`, `restructure.apply` | Claude Opus | Prose quality |
| `web.find_sources` | Claude Sonnet with the web search tool | Proposes public supporting resources with URLs |
| `extract.text`, `extract.tables` (PDFs, images, scans: text transcription/OCR and tables from uploads) | Gemini Flash | Already proven in the organizer's extraction pipeline. Gemini's only role |

Model IDs live in configuration (`SASHA_MODEL_FAST`, `SASHA_MODEL_MID`,
`SASHA_MODEL_DRAFT`). Default values: `claude-haiku-5-5`,
`claude-sonnet-5-5`, `claude-opus-5-5`, and the organizer's `GEMINI_MODEL`.

**Dictation.** Live dictation as in deskapp uses the browser's Web Speech API (or
the native iOS bridge). No server model is involved and no audio is kept.

### 4.3 Data model (Postgres, new `db/schema.sql`)

```sql
-- Reused unchanged
audit_log (...)              -- agent, action, args, result, allowed, document_id
app_setting (...)

-- Documents
document (
  id uuid pk, team_id text not null, created_by text,   -- team_id = Clerk Organization id
  title text, type_key text null,             -- null = freeform
  type_confidence real null, type_source text, -- 'user' | 'classifier' | 'restructure'
  content_json jsonb,                          -- the whole TipTap document
  content_text text,                           -- plain text for the classifier and search
  notes text default '',                       -- the scratchpad (decision 16)
  folder_id uuid,                              -- the document's own folder
  status text, archived boolean default false,
  created_at, updated_at, last_classified_at
)
document_section (                             -- metadata only; text lives in content_json
  document_id uuid, section_id text,           -- stable id stored on the heading node
  spec_key text null,                          -- the outline item it satisfies
  notes text default '',                       -- section notes (decision 18)
  status text,                                 -- empty | drafted | edited | reviewed
  last_generated_at, primary key (document_id, section_id)
)
document_version (id, document_id, content_json, reason, created_at)  -- before restructure or rewrite

-- Source library
folder (id uuid pk, team_id text not null, parent_id uuid null, name text, document_id uuid null, created_by)
source (
  id uuid pk, folder_id uuid, blob_url text, filename text, mime text, bytes int,
  kind text,                                   -- file | url | note
  extracted_text text, extraction_status text, summary text,
  created_at
)
document_source (document_id, source_id, role text null, added_at)  -- the many-to-many link
source_passage (id, source_id, page int, start int, end int, text)  -- for citations

-- Data
data_table (id uuid pk, source_id uuid, name text, columns jsonb, row_count int,
            status text,                       -- active | superseded | hidden
            extraction_method text)            -- csv | xlsx | gemini-pdf
data_row (table_id uuid, idx int, values jsonb)
document_data (document_id, table_id)

-- Suggestions (generalizes case_suggestion_edits)
suggestion (id, document_id, kind text,        -- source | data | web
            label text, reason text, spec_ref text null, url text null,
            origin text,                       -- type | notes | coverage
            state text)                        -- open | added | dismissed

-- Catalog (seeded from fixtures; editable)
document_type (key text pk, version int, title text, family text,
               summary text, definition jsonb, provenance jsonb,
               enabled boolean, updated_at)

-- Workflows (renamed from determination_workflow / agent_determination_run)
workflow (id, name, ...)
workflow_version (workflow_id, version, graph jsonb, ...)
workflow_run (id, workflow_id, version, document_id, status, steps jsonb,
              outputs jsonb, checkpoints jsonb, ...)
```

Identifiers move from Blob `group_id` strings to Postgres UUIDs. Blob stores only
the file bytes.

### 4.4 Document-type definition (`src/catalog/types/*.json`, zod-validated)

```ts
DocumentType = {
  key: "nih-r01-research-strategy", version: 1,
  title, family: "grant" | "business" | "academic" | "technical" | "policy" | "clinical" | ...,
  summary,                      // 2–3 sentences; the classifier reads this
  signals: string[],            // phrases and cues for the classifier
  audience, tone, preamble,     // replaces the hardcoded FIE prompt preamble
  sections: [{
    key, heading, level, order, required: boolean,
    guidance,                   // drafting guidance for the model
    lengthHint?,                // e.g. "≤ 1 page"
    elements: string[],         // required elements for the living outline
    sourcesNeeded: string[],    // drive suggested sources
    dataNeeded: string[],       // drive suggested data
    renderer?: "narrative" | "static" | "pack:<name>"   // pack:fie-exclusion etc.
  }],
  rubric: [{ key, criterion, levels: [{ score, descriptor }], appliesTo?: sectionKey[] }],
  provenance: { source, url, license, retrieved }
}
```

`report/template.ts` becomes this type. `report/service.ts` looks the definition up
from the document's `type_key` instead of always using `FIE_TEMPLATE`.

### 4.5 Editor model (decision 4)

- There is one TipTap document per Sasha document. A custom `SectionHeading`
  extension extends Heading with a stable `sectionId` attribute and an optional
  `specKey` attribute. A section is the range from its heading to the next heading
  at the same or a higher level.
- A heading gutter (a floating menu anchored to the heading) holds the section
  actions: Draft, Rewrite (presets from `rewrite-presets.ts`), Check against
  rubric, Cite sources, and Section notes.
- **Section notes** panel: a textarea with a microphone button using the
  `useSpeechToText` hook from deskapp. The action button reads **Draft from
  notes** when the section body is empty and the section has notes, and **Rewrite
  from notes** when the section has content and notes.
- Generated content is inserted as a single undoable transaction, and a
  `document_version` snapshot is taken first.
- Autosave sends the whole document with debouncing (about 1.5 s), using
  optimistic concurrency on `updated_at`. Real-time co-editing is out of scope for
  v1; see the risks in §10.

---

## 5. The document type catalog

### 5.1 Strategy
Hand-curate 20–30 high-quality types in our own schema, citing sources that are
public domain or openly licensed. ClawHub entries are added one at a time when a
skill contains a real outline or rubric (MIT-0 licence). We store
`owner/slug/version` with a link back, and ingest only the markdown text, never
scripts or install steps.

### 5.2 Initial set (v1: 15 types; reach 25–30 by the end of Phase 8)

| Family | Type | Basis (licence) |
|---|---|---|
| Grant | NIH Specific Aims + Research Strategy | NIH guidance and review criteria (US government, public domain) |
| Grant | NSF Project Description + Broader Impacts + Data Management Plan | NSF PAPPG (public domain) |
| Grant | Foundation letter of inquiry / general proposal | Assembled from common foundation formats; hand-written |
| Business | Business plan | SBA business plan outline (public domain) |
| Business | Product requirements document | anthropics/skills `doc-coauthoring` pattern (check its licence), hand-written |
| Business | Strategy memo / review | ClawHub `strategy-review` rubric (MIT-0), curated |
| Technical | Tutorial, How-to, Reference, Explanation (4 types) | Diátaxis (CC BY-SA 4.0; definitions paraphrased, attributed) |
| Technical | Design doc / RFC | anthropics/skills `doc-coauthoring` pattern, hand-written |
| Technical | Standard operating procedure | EPA QA/G-6 (public domain) |
| Academic | Research report (IMRaD) | Standard APA/IMRaD section list (a factual structure, hand-written) |
| Policy | Policy / decision memo | Plain Language guidelines (public domain) plus GSA/18F guides |
| Career | Resume / CV | ClawHub `resume-cv-builder` (MIT-0), curated |
| Clinical | Full and Individual Evaluation | Ported from the organizer's `FIE_TEMPLATE` |

**Universal rubric:** every type inherits a short writing rubric built from the
Federal Plain Language Guidelines and Google's technical writing material
(clarity, concision, audience fit, structure, evidence). AAC&U VALUE rubrics are
excluded because their licence is non-commercial (CC BY-NC-SA); they are an option
if Sasha stays non-commercial.

### 5.3 Pipeline
`scripts/catalog/` contains:
- `build.ts`: validates every `types/*.json` against the zod schema, generates
  `catalog.index.json` (key, title, family, summary, signals), and fails CI on
  invalid definitions.
- `import-clawhub.ts <owner/slug>`: fetches one skill's `SKILL.md` through the
  public API (`/api/v1/skills/{slug}/file`), checks `/verify` and the moderation
  status, removes URLs and install commands, asks Sonnet to draft a definition in
  our schema, and writes it to `types/_drafts/` for human review. It is never
  scheduled (decision 9).
- An in-app catalog admin page lists, enables, disables and edits types. User-made
  types (for example "save my outline as a type") are stored in `document_type`.

---

## 6. Feature specs

### 6.1 Home and the document list
- `/` creates a new, empty, untitled document on the first keystroke (no empty
  rows) and opens the editor full-screen.
- A switcher in the header lists documents with search, a type filter, an
  archived view and recent documents. It replaces `upload-groups-list.tsx`.
- `/d/[id]` opens a document. The intercepting `@modal` route pattern is reused
  for the document modal (`/d/[id]/info`).

### 6.2 Document modal (adapted from `case-detail-view.tsx`)
| Pane | Contents |
|---|---|
| **Notes** | One running scratchpad. A microphone button provides live dictation (deskapp `useSpeechToText`, Finish/Cancel as in its `ChatInput.tsx`). Autosaved. No audio is kept |
| **Type** | Current type, confidence, top 3 alternatives, "Choose type…", and "Restructure to…" |
| **Outline** | The living outline: the type's sections and required elements with a status for each (missing / partial / done), linked to headings |
| **Sources** | The document's folder plus linked sources, an "Add from library" picker, the upload dropzone, and suggested sources |
| **Data** | Extracted tables with a preview, column types, hide/supersede controls, and suggested data |
| **Workflows** | Run coverage, restructure, or user workflows; run history and the inspector |

### 6.3 Classifier (decision 10)
- Triggered on the client when (a) typing has paused for 5 s **and** at least 150
  words have changed since the last run, or (b) the notes change and have been idle
  for 5 s. At most one run per 2 minutes per document, and never once the user has
  chosen a type unless the text drifts strongly.
- `POST /api/documents/[id]/classify` sends Haiku the cached catalog index plus the
  first ~3k tokens of notes and text. It returns `{ candidates: [{key, confidence,
  why}], freeform: boolean }`.
- The UI shows a quiet chip, "Looks like a *Business plan*: apply outline?". Three
  dismissals of the same type stop that suggestion for the document.
- When applied to a document that already has text, the restructure flow (§6.7)
  runs in **merge** mode: the outline is added around the existing content, and no
  prose is rewritten.

### 6.4 Suggestions (rewrite of the organizer's generation; reuse of its edit store and UI)
- **Type-driven:** the union of `sourcesNeeded` and `dataNeeded` across the type's
  sections, minus what linked sources and data already cover. Coverage is judged
  by Haiku against source summaries.
- **Notes-driven:** Haiku reads the notes and the type and proposes specific items,
  for example "Last year's audited financials", each with a reason.
- **Web-driven:** comes from the coverage workflow (§6.7).
- `suggestion-list.tsx` and `case-suggestions.ts` are reused (add, dismiss,
  restore) with the kinds renamed to `source | data | web`.

### 6.5 Sources library (decision 5)
- Folders form a tree. Each document gets a folder automatically, and uploads from
  a document land there. A library view (`/library`) lets you browse, move and
  search all sources and link any source into any document.
- The upload pipeline is reused: presign, direct upload to Blob, then `complete`,
  followed by Gemini text extraction, a Haiku summary, and passage chunking for
  citations. The clinical `runGovernedPipeline` and `extractSubjectInfo` calls are
  removed.
- URL sources: paste a URL, the server fetches and extracts it (Readability), and
  the source is stored with `kind=url`.

### 6.6 Data (decision 6)
- CSV through `papaparse` and XLSX through SheetJS: every sheet becomes a
  `data_table`, with header detection and column type inference
  (number/date/text/currency/percent).
- PDF: Gemini table extraction to strict JSON, using the multimodal pattern from
  the organizer's `assessment/extract.ts`. A classifier step ("does this page
  contain tables?") is reused from `assessment/classify.ts`.
- The supersede/hide/override and audit rules are reused from
  `assessment/service.ts`.
- Insert into document: "Insert table" places a TipTap table snapshot with a
  citation link back to the `data_table`. Charts are deferred.

### 6.7 Workflows (decision 11; reuses the canvas and engine)
New node set. The generic organizer nodes are kept: `ai.ask`, `ai.extract`,
`ai.categorize`, `text.combine`, `logic.if`, `logic.router`, and `checkpoint`
(renamed from `clinical.checkpoint`).

| Node | Purpose |
|---|---|
| `doc.read` | The document text, its sections, and its type definition |
| `doc.notes` | The notes scratchpad and section notes |
| `sources.list` / `sources.read` | Linked sources, with summaries and passages |
| `data.list` | Linked data tables |
| `type.coverage` | Scores each section's `sourcesNeeded`/`dataNeeded` and each required element as supported / weak / missing, with evidence passages |
| `web.find` | Sonnet with web search: proposes public resources for the gaps (government data portals, standards, papers), with URLs and why each fits |
| `rubric.score` | Scores the draft against the type's rubric plus the universal rubric |
| `doc.write` | Writes to the document (a section, a comment, or the outline status). Takes a version snapshot first |
| `suggest.emit` | Turns findings into suggestions (source / data / web) |

Built-in workflows:
1. **Source coverage review:** `doc.read` + `sources.list` + `data.list` →
   `type.coverage` → `logic.if(gaps)` → `web.find` → `suggest.emit`, plus a report
   in the inspector.
2. **Restructure to type:** `doc.read` → plan (Sonnet: map existing content onto
   the target type's sections, list content that doesn't fit, list gaps) →
   `checkpoint` (the user approves the mapping) → apply (Opus: move content, add
   empty sections, add only transitional prose) → `doc.write` with a version
   snapshot. Modes: **merge** (keep the text, add the outline) and **rewrite**.
3. **Draft all empty sections:** for each empty section, draft from notes and
   sources, then `rubric.score`.

Per-type workflows are specified in `docs/workflows-by-document-type.md`. They
are built from seven shared steps (gate, extract, trace, compute, independent
review with differing briefs, agreement without averaging, checkpoint);
outcomes are advisory until their checkpoint and always allow "blocked: missing
input"; requirement sets (state criteria, NIH/NSF rules, reporting guidelines)
are stored as dated data beside the type. "Draft all empty sections" is off by
default for NIH (NOT-OD-25-132).

The engine's 200 s budget with pause and continue is kept. The tables are renamed
as in §4.3.

### 6.8 Citations
- Passages are created when a source is extracted (`source_passage`). Drafting
  prompts receive numbered passages, and the model returns `[[p:ID]]` markers.
  The server verifies quotes against passages using the organizer's `passages.ts`.
  Markers become a `citation` TipTap mark that shows the passage on hover and opens
  the source.
- On export, citations become footnotes (DOCX and PDF) or reference links
  (Markdown).

### 6.9 Rubric check (decision 7)
- An on-demand "Check" control on a section or the whole document runs
  `rubric.score` on Sonnet. It returns, for each criterion, a level, evidence and a
  suggested fix. The results appear in a side panel, and each fix has an "Apply"
  action (rewrite with that instruction).

### 6.10 Export (decision 8)
- **Markdown:** a `tiptapToMarkdown` function (new, the inverse of the reused
  converter).
- **DOCX:** the `docx` library mapping headings, paragraphs, lists, tables,
  images and footnotes.
- **PDF:** server-side HTML (from the reused `tiptapToHtml`) plus print CSS,
  rendered with `@sparticuz/chromium` and Puppeteer in a Vercel function. If cold
  starts or bundle size are a problem, the fallback is client-side `window.print()`
  with print CSS.

### 6.11 Learn from an example (evaluation, Phase 8)
Given one or more example documents (uploaded as sources), extract a reusable
**skill** (a document type) and a **workflow** that produce documents like the
example. Built as an evaluation first: it ships only if the round-trip test
below shows it beats starting from the nearest catalog type.

- **Extract the skill** (Opus, examples as delimited data): outline with section
  purposes and lengths, per-section guidance, sources and data each section
  draws on (`sourcesNeeded`/`dataNeeded`), voice and formatting conventions,
  classifier signals, and a draft rubric. The result is a
  `DocumentTypeDefinition` saved as a team type through the existing
  `from-document` path, so the catalog editor, classifier and suggestions pick
  it up unchanged. Guidance describes the pattern and never copies the
  example's facts, names or sentences; a check flags long verbatim overlaps.
- **Extract the workflow:** infer the outcome and checks the example implies
  (totals that must agree, required elements, sign-offs) and express them as a
  graph of the seven shared steps (§6.7, `docs/workflows-by-document-type.md`).
  Requirement sets the example implies are saved as dated data, marked inferred.
- **Checkpoint:** the author reviews the proposed type and workflow side by side
  with the example (what was inferred from where) before either is saved.
- **More examples, better result:** with two or more, keep what they share and
  report where they differ; a single example is labelled low confidence.
- **Evaluation (round trip):** for an example whose own sources are available,
  generate a new document from those sources with the extracted type and
  workflow, then score it against the example on structure (section match),
  coverage of the example's key points, rubric score, and workflow findings.
  Compare with the same run using the nearest catalog type and with no type.
  Use a small set of public examples per family (e.g. NIAID sample
  applications, published SOPs and design docs) as a fixed test set.
- **Privacy:** examples may be confidential or contain personal data (FIE,
  resumes). They stay team-scoped sources; extracted types keep no personal
  details.

---

## 7. Implementation phases

Effort is in developer-days. Each phase ends with tests passing, `lint` and
`typecheck` clean, and a deploy to a preview.

### Phase 0: Bootstrap (2–3 d)
1. Copy the organizer into Sasha without history. Delete the Drop set. Move
   `GroupMetadata` out of `exclusion/evidence.ts` and `llm.ts`/`ModelChoice` out of
   `agent-determination/` first, so imports don't break.
2. Rename packages, branding and routes. Remove `@vercel/edge-config`, the `import`
   dependency, and the hardcoded Blob URL fallback. Update the middleware
   allowlist.
3. Create new Vercel, Neon and Clerk projects. Add `.env.example`, update
   `setup-local-env.sh`, and add a GitHub Actions CI job (lint, typecheck,
   vitest).
4. Keep the surviving tests green: markdown-to-tiptap, the workflow engine,
   validate, edge-routing, run-stats, gemini-files, pdf-chunks,
   resumable-upload, extracted-text, processing-jobs, text-match, passages.

### Phase 1: Documents and editor (5–6 d)
1. New schema (§4.3) with migrations. Use plain SQL files and a tiny runner, or
   drizzle-kit; drizzle is recommended for typed queries.
2. Document CRUD API, `/` creates a blank document, `/d/[id]` editor, document
   switcher, archive.
3. Single-document TipTap editor: `SectionHeading` extension, autosave,
   `content_text` projection, version snapshots.
4. `lib/llm` with task routing and the Anthropic SDK; record token usage in
   `audit_log`.

### Phase 2: Sources library (3–4 d)
1. Folder tree, `source`, `document_source`, the library page, and the picker for
   linking sources into documents.
2. Adapt the upload pipeline (presign/direct/complete → extraction → summary →
   passages). Add URL sources.

### Phase 3: Document types, outline and section tools (6–8 d)
1. Catalog schema, `build.ts`, the first 10 types, and the catalog admin page.
2. "New document of type…" generates the outline, and section headings carry
   `specKey`.
3. Living outline pane (element status from Haiku, refreshed on save with
   debouncing).
4. Heading gutter actions: Draft and Rewrite on Opus, presets, section notes
   with dictation, Draft/Rewrite from notes.
5. Port `report/service.ts` generation onto the type definition
   (preamble/guidance from data).

### Phase 4: Notes, classifier and suggestions (4–5 d)
1. Document modal shell (adapted `case-detail-view`, `case-shell`, `case-nav`) and
   the Notes pane with the `useSpeechToText` port (including the native bridge
   contract, for a future iOS shell).
2. Classifier endpoint and client trigger, chip UI, dismiss memory.
3. Suggestion generation (type plus notes) on the reused suggestion UI and edit
   store.

**Milestone A (end of Phase 4): usable for real writing.**

### Phase 5: Data (4 d)
CSV/XLSX parsing, Gemini PDF table extraction, the Data pane, insert table,
suggested data.

### Phase 6: Workflows (6–8 d)
1. Rename tables and nodes. Remove the clinical nodes from `engine.ts` and
   `registry.ts`; add the new nodes (§6.7).
2. Source coverage workflow including `web.find`.
3. Restructure workflow (merge and rewrite modes, checkpoint approval) wired to
   the classifier chip.
4. Draft-all workflow; update `engine.test.ts` mocks.

### Phase 7: Citations, rubric check and export (5–6 d)
Citation mark and quote verification, the rubric panel with apply-fix, and
Markdown/DOCX/PDF export with footnotes.

### Phase 8: FIE type, the rest of the catalog, learn from an example (5–7 d)
1. FIE as a document type: outline and narrative guidance only (decided). The
   clinical pipeline is not ported.
2. Expand to 25–30 types, including curated ClawHub imports.
3. Learn from an example (§6.11): extract a type (skill) and workflow from
   example documents, with an author checkpoint, then run the round-trip
   evaluation against the nearest catalog type. Needs the Phase 6 engine and
   the Phase 7 rubric. Also used to draft some of the new catalog types.

### Phase 9: Hardening (3–4 d)
Rate limits per user on model routes, cost dashboard (tokens by task from
`audit_log`), Playwright smoke tests for the editor, modal, upload and export,
and accessibility checks.

---

## 8. Files to reuse or adapt from the organizer (by path)

- **Reuse as-is:**
  - `src/components/ui/*`
  - `src/lib/report/markdown-to-tiptap.ts`, `editor-extensions.ts`
  - `src/lib/workflow/{types,validate,template,edge-routing,run-stats,model-json}.ts`
  - `src/lib/ontology/{governance,text-match,ensure-schema}.ts`
  - `src/lib/ontology/agent-determination/passages.ts`
  - `src/lib/{gemini*,pdf-chunks,resumable-upload,extracted-text,blob-*,upload-strategy,processing-*}.ts`
  - `src/app/api/upload/{presign,direct}`
  - workflow `routed-edge`, `canvas-context`, `run-timeline`, `workflow-picker`
- **Adapt:**
  - `src/components/report-editor.tsx` (continuous document plus heading gutter)
  - `src/lib/ontology/report/service.ts`, `rewrite-presets.ts`
  - `src/components/case-detail-view.tsx` → `document-modal.tsx`
  - `upload-groups-list.tsx` → `document-switcher.tsx`
  - `summary-note.tsx` → `notes-pane.tsx`
  - `suggestion-list.tsx`, `case-suggestions.ts`, `suggestion-edits.ts`
  - `src/lib/workflow/{engine,registry,auto-run}.ts`
  - `workflow-canvas.tsx`, `node-settings.tsx`, `run-history.tsx`, `run-inspector.tsx`
  - `assistant/agent.ts`, `assistant/governance.ts`
  - `assessment/{classify,service}.ts` → `data/`
  - `upload/route.ts`, `upload/complete/route.ts`
  - `permissions.ts` (Clerk Organization roles: admin, member; all documents and
    sources are shared team-wide)
- **From deskapp:** `apps/web/src/components/useSpeechToText.ts` (283 lines) and
  the Finish/Cancel dictation pattern in `ChatInput.tsx`.
- **Rewrite:** `report/template.ts` → `catalog/schema.ts`; `ontology/catalog.ts`;
  `workflow/default-graph.ts`; `assessment/{extract,scoring,domains,instruments}.ts`
  → `data/extract.ts`; `assistant/{objects,functions,menu}.ts`.

---

## 9. Testing strategy

- **Unit (vitest):** catalog schema validation, section range detection, the
  classifier trigger logic (pure), suggestion diffing, CSV/XLSX inference, citation
  marker parsing and quote verification, restructure mapping application,
  exporters (golden files).
- **LLM contract tests:** recorded fixtures for each task's JSON schema, plus one
  live smoke run per task that runs only when the keys are present.
- **E2E (Playwright, pre-installed Chromium):** new document → type → outline →
  draft section → export DOCX; upload CSV → insert table; dictation is mocked
  through the `window.__deskDictation` bridge contract.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Large single documents make autosave and context heavy | Debounced whole-document saves are fine below about 50 pages. Send only the relevant sections plus the outline to models |
| Concurrent edits by teammates overwrite each other | Optimistic concurrency with a conflict prompt in v1. Yjs/Hocuspocus co-editing is a later option |
| Web Speech quality varies by browser; Firefox has none | Hide the microphone when unsupported |
| Background classification costs | Haiku, a cached catalog prompt, word-delta and rate gating. Estimate under $0.01 per run |
| Prompt injection from sources or ClawHub content | Sources are passed as delimited data. Tools on workflow nodes are read-only unless the node is `doc.write`. ClawHub imports are sanitized and reviewed by a person |
| PDF export on Vercel (Chromium size and cold starts) | `@sparticuz/chromium`; client print fallback |
| Licences of catalog sources | Store provenance for each type; avoid NC-licensed rubrics; paraphrase CC BY-SA material and attribute it |

---

## 11. Resolved items (October 2026)

1. **FIE depth:** outline and narrative guidance only.
2. **Classifier trigger:** 5 s pause and at least 150 changed words, or a notes
   change; at most once every 2 minutes; quiet chip.
3. **Gemini:** used only to read uploads (text transcription/OCR from PDFs and
   images, and table extraction). Dictation uses the browser.
4. **Team model:** team-wide sharing through Clerk Organizations. Every document,
   folder, source, data table and workflow belongs to a `team_id`; every member
   of the organization can see and edit them.

---

## 12. Progress

**Phase 0 (done).** Pruned copy; clinical modules removed; workflow nodes,
report templates, assistant tools and permissions made domain-neutral; CI.

**Phase 1 (done).**
- `document`, `document_section`, `document_version` tables (`src/lib/documents/store.ts`), team-scoped
  (`org:<clerk org>` or `user:<clerk user>`), optimistic concurrency on `updated_at`, in-memory fallback
  without `POSTGRES_URL`.
- API: `/api/documents` (list, create), `/api/documents/[id]` (get, save with conflict detection,
  delete), `/versions` (snapshots), `/rewrite` (Claude, `rewrite.selection`), `/api/document-types`.
- Editing screen (`src/components/editor/`): opens on a blank document; header with Docs switcher,
  title, type picker, Sources, Share, account; toolbar; section headings with stable ids; dividers
  with add/delete section; Outline and Tools panels; autosave with a conflict banner.
- Model routing (`src/lib/llm/tasks.ts`, `claude.ts`): Haiku 5.5 / Sonnet 5.5 / Opus 5.5 by task,
  refusal fallback on Sonnet and Opus, usage in the audit log. Report drafting, the assistant and
  workflow AI nodes now run on Claude; Gemini only reads uploads.
- The old case list moved to `/library` until Phase 2 replaces it with the source library.
- `SASHA_DEV_AUTH_BYPASS=1` (ignored in production) for local development and browser tests.
- Type picker: Proposal, Memo, General Report and FIE outlines for now; Phase 3 replaces the list
  with the catalog. Choosing a type on a document with text appends only the missing sections.

**Phase 1 hardening (done, with Phase 2).** Autosave retries only transient failures, with backoff;
keepalive saves only under 60 KB; the rewrite tool tracks its selection through edits made while the
model runs; duplicate section ids keep the original heading's id; archive, restore and delete in the
switcher (the legacy `/archived` page is gone); workflow model calls are audited (`llm:workflow`);
`claudeJson` surfaces refusals and truncation; requests over 16k output tokens stream.

**Phase 2 (done).**
- `folder`, `source`, `document_source`, `source_passage` tables (`src/lib/sources/store.ts`),
  team-scoped, with the same in-memory fallback. Each document gets its own folder on first use.
- API: `/api/folders` (tree, create, rename, move with cycle check, delete), `/api/sources` (list with
  search and filters, create URL or note sources), `/api/sources/[id]` (+ `/passages`, `/retry`,
  `/file`), `/api/documents/[id]/sources` (link, unlink).
- Upload: presign → direct Blob upload → complete now creates `source` rows. Blob paths are
  `sources/<team hash>/<uuid>/<name>-<suffix>`; `complete` accepts only the presigned path on our own
  store, and the store token is never sent to any other host. The server upload path is removed.
- Ingest (`src/lib/sources/ingest.ts`): Gemini for PDFs and images, direct reads for text, Readability
  (`@mozilla/readability` + `linkedom`) for URLs, a Haiku summary over delimited source text, and
  page-aware passages with stable ids (`S<id8>.P<n>`) for Phase 7 citations.
- URL sources are guarded against SSRF: http(s) only, private, loopback, link-local and embedded-IPv4
  ranges are refused before the fetch and again at connect time, and each redirect is re-checked.
- UI: a Sources panel in the editor (upload, paste link, note, pick from library), the `/library` page
  (folder tree, search, kind filter, detail drawer, link to documents), and a tracker that follows
  sources while they are read.
- Files are served only through the team-checked `/file` route and paths cannot be guessed. (Phase 4
  moved to `@vercel/blob` 2.x and private access; see below.)

**Phase 3 (done).**
- Catalog: zod `DocumentTypeDefinition` (`src/catalog/schema.ts`), universal rubric, 12 file types in
  `src/catalog/types/` (NIH Specific Aims + Research Strategy, business plan, PRD, design doc/RFC, SOP,
  IMRaD report, policy/decision memo, Diátaxis how-to and tutorial, FIE outline, general report,
  proposal). `npm run catalog:build` validates them and writes `catalog.bundle.json` and
  `catalog.index.json`; CI runs it with `--check`. Old keys (`memo`, `general_report`, `fie_basic`) are
  aliases.
- `document_type` table for team edits, team-made types and enable/disable; the loader merges file
  types with team rows. `/api/document-types` (list, get, edit, enable, revert, create,
  `from-document` = save outline as type) and the `/catalog` admin page (admins edit, members read).
- New document of a type builds the outline with `specKey` headings; the type picker and gallery read
  the catalog; "Start from a type" on blank documents.
- Section tools in a heading gutter: Draft, Rewrite (presets, "less" variants, custom), Section notes
  with dictation (`src/hooks/use-speech-to-text.ts`, ported from deskapp, `__sashaDictation` bridge)
  and Draft/Rewrite from notes. Generation (`src/lib/sections/`) runs on Opus, grounded in the
  document's linked sources and passages and the type's preamble and section guidance, snapshots a
  version first, and is applied as one undoable step, with a prompt if the section changed meanwhile.
- Living outline: section and element status (Haiku, cached, rate-gated), links to headings, "Add" for
  missing sections.
- The legacy report service reads its templates from the catalog through an adapter.
- No real model call was exercised in the smoke test (no API key locally); the routes return 503 when
  Claude is not configured.

**Editor layout (done, between Phases 3 and 4).** Built from the user's two mockups: a narrow left
rail (documents, library, document types, account, the Sasha mascot); a docs panel that slides in from
the left with the open document marked Active and outlined, Select for bulk archive/delete/move, and
new **document folders** (`document_folder`, `document.doc_folder_id`, `/api/document-folders`,
`/api/documents/bulk`), separate from Phase 2 source folders; floating Outline, Tools and Sources
buttons at the bottom right, with Outline and Tools stacked in the editor's right column. Cabin for
the interface, Hanken Grotesk for the document.

**Phase 4 (done).**
- Live checks against the real services (Blob, Gemini, Haiku, Opus). The project's Blob store is
  private, so `@vercel/blob` moved to 2.x and every write goes through `src/lib/blob-access.ts`
  (private by default; `BLOB_ACCESS=public` for a public store). Fixes from those runs: wiki noise
  stripped from URL sources, summaries describe rather than judge and know today's date, rewrites stay
  in proportion with few placeholders, and the console audit line shows model and tokens.
- Dev bypass no longer opens Clerk's "Organizations feature required" popup (`dev-auth-context.tsx`).
- **Document modal** (`document-modal.tsx`) replaces the Sources modal, with Notes, Sources and
  Suggestions tabs. The Sources button opens it on Sources; a Notes control beside the title opens it
  on Notes. Document notes autosave with the document (same conflict check, capped length) and support
  dictation through a shared `DictationField`.
- **Classifier** (`src/lib/classifier/`, `/api/documents/[id]/classify` + `/dismiss`): Haiku with the
  team's catalog as a cached system prompt; runs after 150+ words and a pause, or after enough drift
  on a typed document; a 2-minute server gate; a chip "Looks like a **Type**: apply outline?" with
  Apply / Not now / other suggestions. Three dismissals of a type stop it being offered. Apply merges
  the outline in without changing prose (tags matching headings, inserts missing sections, one undo).
  Classifier writes never touch `updated_at`, so they cannot cause save conflicts. Team-written type
  text is escaped and treated as data in the prompt.
- **Suggestions** (`src/lib/suggestions/`, `/api/documents/[id]/suggestions/**`): the type's sources
  and data needs, plus notes-driven items from Haiku, judged against linked sources (covered, partial,
  missing). Items can be added (optionally linked to a source), dismissed and restored; dismissed items
  stay dismissed across runs, and the model sees its earlier items so labels stay stable. Regenerates
  in the background 15 s after the type, notes or linked sources change, and when the tab opens stale;
  a failed run is retried. The legacy case-suggestions code is removed.
- Recorded model replies (`__fixtures__/*.recorded.json`) back offline contract tests; re-record with
  `SASHA_LIVE_TESTS=1 SASHA_RECORD_FIXTURES=1`.
- Smoke-tested in Chrome with real Haiku: the chip appeared after typing a business plan, Apply added
  9 headings with prose byte-identical, and the Suggestions tab listed items from the type and notes.

**Phase 5 (done).**
- `data_table`, `data_row`, `document_data` and cell overrides (`src/lib/data/store.ts`), team-scoped,
  memory fallback; deleting a source removes its tables and links.
- Extraction (`src/lib/data/`) inside source ingest: CSV through papaparse (encoding detection,
  windows-1252), XLSX through SheetJS 0.20.3 from cdn.sheetjs.com (no formulas or macros, zip-bomb
  guard on both central-directory and local headers, size caps), header detection including merged
  two-row headers and year/month header rows, column types number/date/currency/percent/text.
  PDFs and images: Gemini table pass to strict JSON alongside the summary; a partial failure keeps
  the other tables. Re-reading supersedes old tables and moves document links and suggestion
  coverage to the new ones.
- API: `/api/data/tables` (list, get with paged rows, patch: rename, column, hide, supersede,
  restore, cell override and revert, all audited), `/csv` export (BOM, formula-safe),
  `/api/documents/[id]/data` (link, unlink).
- UI: a Data tab in the document modal (preview with typed columns, link from linked sources or
  the library, hide/supersede/override), Insert table at the cursor as one undo step with a source
  line and `dataTableId` saved on the node; the library drawer lists a source's tables.
- Suggested data: linked tables cover data items and "Add" records the table.
- Debts closed: PATCH document returns 400 on invalid JSON; failed linked PDFs give link advice.

**Phase 6 (done).**
- Engine for documents (`src/lib/workflow/`): runs are scoped to a team and a document; workflows,
  runs and settings carry `team_id`; the clinical nodes, legacy upload groups, cases, report service,
  assistant and their routes and components are removed (the `report` tables are no longer created;
  older databases may still have them). 300 s budget with pause and continue, resumable loops,
  checkpoint pause/resume, retry claims a run once.
- Nodes: `doc.read`, `doc.notes`, `sources.list/read`, `data.list`, `type.coverage`, `web.find`
  (Sonnet with server web search; results unverified until accepted; sensitive types send only
  catalog gap labels and are limited to listed domains), `rubric.score`, `doc.write` (snapshot first),
  `suggest.emit`, and the seven shared steps from `docs/workflows-by-document-type.md`: gate,
  extract, trace, compute (in code), independent review with differing briefs (advocate, skeptic,
  auditor), agreement without averaging, checkpoint with who/when/role.
- Catalog: 8 dated requirement sets (`src/catalog/requirements/`) and 15 workflow definitions
  (`src/catalog/workflows/`): source coverage, restructure (merge/rewrite, mapping table with
  unplaced content, verbatim moves), draft all (sentence-level support, off by default for NIH),
  and per-type workflows for the 12 catalog types, with general report as the default.
- UI: a Workflows tab in the document modal (available workflows, progress, fixed-value outcome,
  findings linking to passages, disagreements with both rationales, checkpoint forms, history);
  the type chip offers Restructure; the canvas shows built-ins read-only and edits team copies.
- Smoke-tested with real models: a planted budget total and a date-order error were caught by code;
  the FIE without consent was blocked with the missing input named and no student details in web
  queries; restructure kept every paragraph verbatim.

**Phase 7 (done).**
- Citations (`src/lib/citations/`): drafting, rewrites and draft-all get numbered passages and return
  `[[p:ID]]` markers; the server keeps a marker only if the passage exists, belongs to a source linked
  to this document and team, and any quote matches (whole-word, numbers exact). Dropped markers are
  reported. Kept markers become a `citation` mark with a numbered reference, a passage popover on
  hover or Alt+Enter (phones: tap), and Open source to the library with the passage highlighted.
  Data-table source lines cite the table. A wording guard rejects rewrites that change text they
  should only cite. `GET /api/documents/[id]/citations` lists references and problems.
- Rubric check (`src/lib/rubric/`, `/api/documents/[id]/check`): Sonnet scores a section or the
  whole document against the type and universal rubrics, with evidence quoted from the document
  (verified) and a fix per criterion; cited text counts as sourced. Cached by inputs hash, atomic
  hourly cap. A Check panel in the right column; Apply rewrites the section through the generation
  path (snapshot first, one undo, prompt if it changed since the check).
- Export (`src/lib/export/`, `/api/documents/[id]/export`): Markdown (references list, GFM tables),
  Word via `docx` (footnotes, lists, tables, images), PDF via puppeteer-core with
  `@sparticuz/chromium` on Vercel or local Chrome, requests intercepted, rate-capped; an explicit
  print fallback when no browser is available. Export menu next to Share.
- Phase 6 debts closed: a blocked FIE no longer waits for sign-off; the canvas accepts
  `?workflowId=`; draft-all shows per-section progress.

**Phase 8 (done).**
- Catalog: 26 types, 12 dated requirement sets, 29 workflows (one per type plus source coverage,
  restructure and draft all). New types: NSF project description (with the Data Management and
  Sharing Plan), foundation letter of inquiry, funder progress report, strategy memo, resume/CV,
  cover letter, literature review, response to reviewers, IEP, reevaluation review, FBA/BIP,
  Diátaxis reference and explanation, incident postmortem. New sets: NSF PAPPG, Uniform Guidance
  reporting, IDEA IEP and discipline (34 CFR). The FIE outline was checked against the organizer
  template. `docs/workflows-by-document-type.md` lists all 26 as "In catalog"; the five
  Sasha-drafted entries are labelled for the owner's review.
- Engine additions: trace `exemptField` (a need with a stated reason for no goal is a note, not a
  gap), count checks with a `status` list, deadlines in years and by report kind (`byKind`), decide
  shows counts as values. The gate ignores unfilled template lines and matches keywords at word
  starts (acronyms whole-word).
- Learn from an example (`src/lib/learn/`, `/api/document-types/learn{,/save}`, `src/components/learn/`):
  1–5 examples from the library to a draft type, workflow and inferred requirement set, with
  confidence by example count, differences between examples, nearest catalog type, verbatim-overlap
  and personal-detail checks (names, all-caps headers, IDs, contacts; assessment names and role
  words exempt; the author can keep a name or organization flag, never contact or ID details).
  Side-by-side review with type editing, then a checkpoint save that creates team rows atomically
  (server-owned set fields; no orphan on failure). "Use it for this document" applies the type.
  Evaluation harness `npm run learn:eval` (learned vs nearest catalog type vs no type).
- `npm run catalog:import` (`scripts/catalog/import-clawhub.ts`): ClawHub skills to drafts in
  `src/catalog/types/_drafts/` for review; refuses unless every declared licence is permissive and
  the security scan is clean; untrusted strings are stripped of control characters.
- Restructure of an already restructured document drops heading-only rows, and the mapping
  checkpoint lists the headings that will be removed before apply (user decision, 2026-10-08).
- Phase 7 debts closed: the workflow rubric step sees citations; export references give a URL
  source's own address and title (no in-app links); excerpts are plain text (including table rows);
  the Check panel opens from cache without "Checking for changes…".
- Smoke-tested with real models: all 14 new workflows reached a valid outcome (the resume run caught
  "seven years" against a history starting in 2018; IEP with no evaluation was blocked); learning
  from two examples took 168 s and the saved team type and workflow ran on a new document. One
  evaluation case (PEP 572): the learned type scored 26% structure match vs 2.5% for the nearest
  catalog type; verdict inconclusive on one case.

**Known debt carried forward.**
- Learn from an example runs close to the time limit (one example took 256 s before the effort was
  lowered to medium; five long examples may pass the first call's 200 s limit). Not re-timed.
- The evaluation harness needs more cases: coverage scores are 100% for every condition when a case
  has no public sources, and the no-type run is scored on the universal rubric only, so rubric
  scores are not comparable across conditions.
- Incident postmortem: time to detect, mitigate and resolve are checked by the responder reviewer,
  not computed in code (needs a `duration` compute kind).
- The ClawHub importer refuses skills with no declared licence, which is most of them.
- `fba-bip` may search pbis.org (not a .gov site); remove it if sources must be government only.
- The 2026 Texas §89.1040 amendment was read from a summary, not the published text; check it.
- A two-capital-word learned title with no document words (e.g. "Software Design Document") is
  flagged as a name; the author can keep it at save.
- ClawHub draft `retrieved` dates are UTC.
- Resume/CV workflow has no Tailor step (spec step 4) and so no changed lines for the candidate to
  approve (spec step 8): it checks a resume the candidate has tailored. The departure is stated in the
  workflow's notes and not-assessed list. For the doc owner to decide: add a tailor node that proposes
  line rewrites from the master history, truth-checked before the "after" score, applied through
  `doc.write` so each line can be accepted.
- Draft-all credits facts from document notes to the section's notes when the section has its own.
- Model judgements are lenient in places (coverage, FIE input check, report support levels); code
  checks catch the arithmetic cases.
- Re-reading a source drops table renames and cell overrides (v1 behaviour).
- Suggestions marked added keep pointing at a table or source after it is deleted.
- Deployments with a public Blob store must set `BLOB_ACCESS=public`.
- Suggestions only learn of source changes while the Sources tab is open; near-duplicate catalog
  labels are not merged; some business-plan item labels are lowercase.
- Section status `edited`/`reviewed` is never set; the outline-status cache and rate gate are per
  server process.
- No migration runner yet; schema changes are idempotent DDL kept in step across the store
  constants, `db/schema.sql` and the setup route.

---

## Sources

- https://github.com/openclaw/clawhub (`docs/http-api.md`, `docs/skill-format.md`, `docs/publishing.md`)
- https://clawhub.ai/api/v1/openapi.json
- https://github.com/VoltAgent/awesome-openclaw-skills
- https://github.com/anthropics/skills
- https://diataxis.fr
- https://grants.nih.gov
- https://new.nsf.gov/policies/pappg
- https://www.sba.gov/business-guide/plan-your-business/write-your-business-plan
- https://www.epa.gov/quality/guidance-preparing-standard-operating-procedures-epa-qag-6-march-2001
- https://www.plainlanguage.gov/guidelines/
- https://developers.google.com/tech-writing
- https://www.aacu.org/initiatives/value-initiative/how-to-cite
- https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents/
- https://tiptap.dev/docs
- https://docx.js.org
- https://sheetjs.com
- https://github.com/Sparticuz/chromium
