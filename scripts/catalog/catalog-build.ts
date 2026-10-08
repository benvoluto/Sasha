// The catalog build, as pure functions plus one thin I/O wrapper, so it can be
// unit-tested. scripts/catalog/build.ts is the CLI (`npm run catalog:build`).
//
// Reads every src/catalog/types/*.json (sub-directories such as _drafts/ and
// dotfiles are ignored), validates each with parseDefinition, checks that the
// file name equals the key and that keys and aliases are unique across types,
// then writes src/catalog/catalog.bundle.json (validated definitions, defaults
// applied, sorted by key, sections sorted by order) and
// src/catalog/catalog.index.json (CatalogIndexEntry[] for the classifier).
// Any error: nothing is written. --check: validate and compare instead of write.
//
// Relative imports only (vite-node runs this without the @/ alias).

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDefinition, sortedSections, type CatalogIndexEntry, type DocumentTypeDefinition } from "../../src/catalog/schema";

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

export type CatalogPaths = { root: string; typesDir: string; bundlePath: string; indexPath: string };

export function catalogPaths(root: string): CatalogPaths {
  return {
    root,
    typesDir: join(root, "src/catalog/types"),
    bundlePath: join(root, "src/catalog/catalog.bundle.json"),
    indexPath: join(root, "src/catalog/catalog.index.json"),
  };
}

const readOrEmpty = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

/** Run the build (or the check). Returns the exit code and the lines to print; writes only on success outside check mode. */
export function runCatalogBuild(paths: CatalogPaths, opts: { check?: boolean } = {}): { code: number; lines: string[] } {
  const result = buildCatalog(readTypeFiles(paths.typesDir, paths.root));
  if (!result.ok) return { code: 1, lines: [...result.errors, `catalog: ${result.errors.length} error(s); nothing written.`] };
  const n = result.definitions.length;
  if (opts.check) {
    const stale = [paths.bundlePath, paths.indexPath].filter((p, i) => readOrEmpty(p) !== (i === 0 ? result.bundle : result.index));
    if (stale.length) return { code: 1, lines: [...stale.map((p) => `${relative(paths.root, p)}: out of date`), "catalog: run npm run catalog:build"] };
    return { code: 0, lines: [`catalog: ${n} type(s) valid; generated files up to date.`] };
  }
  writeFileSync(paths.bundlePath, result.bundle);
  writeFileSync(paths.indexPath, result.index);
  return { code: 0, lines: [`catalog: wrote ${n} type(s) to ${relative(paths.root, paths.bundlePath)} and ${relative(paths.root, paths.indexPath)}.`] };
}
