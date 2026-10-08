// The catalog build, as pure functions plus one thin I/O wrapper, so it can be
// unit-tested. scripts/catalog/build.ts is the CLI (`npm run catalog:build`).
//
// Reads every src/catalog/types/*.json (sub-directories such as _drafts/ and
// dotfiles are ignored), validates each with parseDefinition, checks that the
// file name equals the key and that keys and aliases are unique across types,
// then writes src/catalog/catalog.bundle.json (validated definitions, defaults
// applied, sorted by key, sections sorted by order) and
// src/catalog/catalog.index.json (CatalogIndexEntry[] for the classifier).
// It also builds the Phase 6 data beside the types: src/catalog/requirements/*.json
// (parseRequirementSet) into requirements.bundle.json and
// src/catalog/workflows/*.json (parseWorkflowDefinition) into
// workflows.bundle.json, with the same file-name and unique-key rules, plus
// cross-checks: every appliesTo key is a catalog type, a workflow's
// requirementSets exist, at most one workflow is the fallback, and
// workflow-policies.json parses and names only catalog types.
// Any error: nothing is written. --check: validate and compare instead of write.
//
// Relative imports only (vite-node runs this without the @/ alias).

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseRequirementSet, type RequirementSet } from "../../src/catalog/requirements-schema";
import { parseDefinition, sortedSections, type CatalogIndexEntry, type DocumentTypeDefinition } from "../../src/catalog/schema";
import { parseWorkflowDefinition, WorkflowPolicies, type WorkflowDefinition } from "../../src/catalog/workflow-schema";

export type TypeFile = {
  /** Path shown in messages, e.g. "src/catalog/types/proposal.json". */
  file: string;
  /** File name without ".json"; must equal the definition's key. */
  name: string;
  raw: string;
};

export type BuildOutput = { definitions: DocumentTypeDefinition[]; bundle: string; index: string };
export type BuildResult = ({ ok: true } & BuildOutput) | { ok: false; errors: string[] };

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Validate the files and produce the generated files' contents. Errors are `file: path: message` lines. */
export function buildCatalog(files: TypeFile[]): BuildResult {
  const errors: string[] = [];
  const valid: Array<{ file: string; def: DocumentTypeDefinition }> = [];
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    let data: unknown;
    try {
      data = JSON.parse(f.raw);
    } catch (e) {
      errors.push(`${f.file}: (root): invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const r = parseDefinition(data);
    if (!r.ok) {
      for (const msg of r.errors) errors.push(`${f.file}: ${msg}`);
      continue;
    }
    if (r.definition.key !== f.name) {
      errors.push(`${f.file}: key: the key "${r.definition.key}" must equal the file name "${f.name}"`);
      continue;
    }
    valid.push({ file: f.file, def: { ...r.definition, sections: sortedSections(r.definition.sections) } });
  }

  // Keys (already unique per file name, but checked anyway) and aliases: unique across types, and an alias is never a key.
  const owner = new Map<string, string>();
  for (const { file, def } of valid) {
    if (owner.has(def.key)) errors.push(`${file}: key: "${def.key}" is also used by ${owner.get(def.key)}`);
    else owner.set(def.key, file);
  }
  const keys = new Set(valid.map((v) => v.def.key));
  const aliasOwner = new Map<string, string>();
  for (const { file, def } of valid) {
    def.aliases.forEach((a, i) => {
      if (keys.has(a)) errors.push(`${file}: aliases.${i}: "${a}" is the key of another type`);
      else if (aliasOwner.has(a)) errors.push(`${file}: aliases.${i}: "${a}" is also an alias in ${aliasOwner.get(a)}`);
      else aliasOwner.set(a, file);
    });
  }

  if (errors.length) return { ok: false, errors };
  const definitions = valid.map((v) => v.def).sort((a, b) => a.key.localeCompare(b.key));
  const index: CatalogIndexEntry[] = definitions.map((d) => ({ key: d.key, version: d.version, title: d.title, family: d.family, summary: d.summary, signals: d.signals }));
  return { ok: true, definitions, bundle: json(definitions), index: json(index) };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Parse each file with `parse`, require the key to equal the file name and keys to be unique. Sorted by key. */
function parseKeyed<T extends { key: string }>(files: TypeFile[], parse: (data: unknown) => Parsed<T>, errors: string[]): Array<{ file: string; value: T }> {
  const out: Array<{ file: string; value: T }> = [];
  const owner = new Map<string, string>();
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    let data: unknown;
    try {
      data = JSON.parse(f.raw);
    } catch (e) {
      errors.push(`${f.file}: (root): invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const r = parse(data);
    if (!r.ok) {
      for (const msg of r.errors) errors.push(`${f.file}: ${msg}`);
      continue;
    }
    if (r.value.key !== f.name) {
      errors.push(`${f.file}: key: the key "${r.value.key}" must equal the file name "${f.name}"`);
      continue;
    }
    if (owner.has(r.value.key)) {
      errors.push(`${f.file}: key: "${r.value.key}" is also used by ${owner.get(r.value.key)}`);
      continue;
    }
    owner.set(r.value.key, f.file);
    out.push({ file: f.file, value: r.value });
  }
  return out;
}

export type WorkflowBuildInput = { requirements: TypeFile[]; workflows: TypeFile[]; policies: { file: string; raw: string } | null };
export type WorkflowBuildOutput = { requirementSets: RequirementSet[]; workflows: WorkflowDefinition[]; requirementsBundle: string; workflowsBundle: string };
export type WorkflowBuildResult = ({ ok: true } & WorkflowBuildOutput) | { ok: false; errors: string[] };

/** Validate requirement sets, workflow definitions and the policies against the catalog's type keys. */
export function buildWorkflowData(input: WorkflowBuildInput, typeKeys: Set<string>): WorkflowBuildResult {
  const errors: string[] = [];
  const sets = parseKeyed(input.requirements, (d) => {
    const r = parseRequirementSet(d);
    return r.ok ? { ok: true, value: r.set } : r;
  }, errors);
  for (const { file, value } of sets) {
    value.appliesTo.forEach((k, i) => {
      if (!typeKeys.has(k)) errors.push(`${file}: appliesTo.${i}: "${k}" is not a catalog type`);
    });
  }
  const setKeys = new Set(sets.map((s) => s.value.key));

  const workflows = parseKeyed(input.workflows, (d) => {
    const r = parseWorkflowDefinition(d);
    return r.ok ? { ok: true, value: r.definition } : r;
  }, errors);
  for (const { file, value } of workflows) {
    value.appliesTo.forEach((k, i) => {
      if (!typeKeys.has(k)) errors.push(`${file}: appliesTo.${i}: "${k}" is not a catalog type`);
    });
    value.requirementSets.forEach((k, i) => {
      if (!setKeys.has(k)) errors.push(`${file}: requirementSets.${i}: no requirement set "${k}"`);
    });
  }
  const fallbacks = workflows.filter((w) => w.value.fallback);
  if (fallbacks.length > 1) errors.push(`${fallbacks[1].file}: fallback: only one workflow may be the fallback (also ${fallbacks[0].file})`);

  if (input.policies) {
    let data: unknown;
    try {
      data = JSON.parse(input.policies.raw);
    } catch (e) {
      errors.push(`${input.policies.file}: (root): invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (data !== undefined) {
      const r = WorkflowPolicies.safeParse(data);
      if (!r.success) for (const i of r.error.issues) errors.push(`${input.policies.file}: ${i.path.join(".") || "(root)"}: ${i.message}`);
      else
        for (const [k, p] of Object.entries(r.data)) {
          if (!typeKeys.has(k)) errors.push(`${input.policies.file}: ${k}: "${k}" is not a catalog type`);
          if (p.sensitive && !p.webDomains.length) errors.push(`${input.policies.file}: ${k}.webDomains: a sensitive type needs public web domains`);
        }
    }
  }

  if (errors.length) return { ok: false, errors };
  const requirementSets = sets.map((s) => s.value);
  const defs = workflows.map((w) => w.value);
  return { ok: true, requirementSets, workflows: defs, requirementsBundle: json(requirementSets), workflowsBundle: json(defs) };
}

/** The type files in `typesDir` (top level only; dotfiles and directories such as _drafts/ are skipped). */
export function readTypeFiles(typesDir: string, root: string): TypeFile[] {
  if (!existsSync(typesDir)) return [];
  return readdirSync(typesDir)
    .filter((n) => n.endsWith(".json") && !n.startsWith(".") && !n.startsWith("_"))
    .filter((n) => statSync(join(typesDir, n)).isFile())
    .map((n) => {
      const path = join(typesDir, n);
      return { file: relative(root, path), name: n.slice(0, -".json".length), raw: readFileSync(path, "utf8") };
    });
}

export type CatalogPaths = {
  root: string;
  typesDir: string;
  bundlePath: string;
  indexPath: string;
  requirementsDir: string;
  workflowsDir: string;
  requirementsBundlePath: string;
  workflowsBundlePath: string;
  policiesPath: string;
};

export function catalogPaths(root: string): CatalogPaths {
  return {
    root,
    typesDir: join(root, "src/catalog/types"),
    bundlePath: join(root, "src/catalog/catalog.bundle.json"),
    indexPath: join(root, "src/catalog/catalog.index.json"),
    requirementsDir: join(root, "src/catalog/requirements"),
    workflowsDir: join(root, "src/catalog/workflows"),
    requirementsBundlePath: join(root, "src/catalog/requirements.bundle.json"),
    workflowsBundlePath: join(root, "src/catalog/workflows.bundle.json"),
    policiesPath: join(root, "src/catalog/workflow-policies.json"),
  };
}

const readOrEmpty = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

/** Run the build (or the check). Returns the exit code and the lines to print; writes only on success outside check mode. */
export function runCatalogBuild(paths: CatalogPaths, opts: { check?: boolean } = {}): { code: number; lines: string[] } {
  const result = buildCatalog(readTypeFiles(paths.typesDir, paths.root));
  const typeKeys = new Set(result.ok ? result.definitions.map((d) => d.key) : []);
  const data = buildWorkflowData(
    {
      requirements: readTypeFiles(paths.requirementsDir, paths.root),
      workflows: readTypeFiles(paths.workflowsDir, paths.root),
      policies: existsSync(paths.policiesPath) ? { file: relative(paths.root, paths.policiesPath), raw: readFileSync(paths.policiesPath, "utf8") } : null,
    },
    typeKeys,
  );
  // Type errors first; the workflow data's type-key checks only mean something once the types are valid.
  const errors = [...(result.ok ? [] : result.errors), ...(result.ok && !data.ok ? data.errors : [])];
  if (!result.ok || !data.ok) return { code: 1, lines: [...errors, `catalog: ${errors.length} error(s); nothing written.`] };
  const outputs: Array<[string, string]> = [
    [paths.bundlePath, result.bundle],
    [paths.indexPath, result.index],
    [paths.requirementsBundlePath, data.requirementsBundle],
    [paths.workflowsBundlePath, data.workflowsBundle],
  ];
  const counts = `${result.definitions.length} type(s), ${data.requirementSets.length} requirement set(s), ${data.workflows.length} workflow(s)`;
  if (opts.check) {
    const stale = outputs.filter(([p, content]) => readOrEmpty(p) !== content).map(([p]) => p);
    if (stale.length) return { code: 1, lines: [...stale.map((p) => `${relative(paths.root, p)}: out of date`), "catalog: run npm run catalog:build"] };
    return { code: 0, lines: [`catalog: ${counts} valid; generated files up to date.`] };
  }
  for (const [p, content] of outputs) writeFileSync(p, content);
  return { code: 0, lines: [`catalog: wrote ${counts}.`] };
}
