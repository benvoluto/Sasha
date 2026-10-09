// `npm run catalog:import -- <owner/slug>`: draft a document type from one
// ClawHub skill (PLAN §5.3). Checks the owner, moderation, the security scan,
// the Skill Card verification when ClawHub offers it, and the licence; strips
// links, commands and code; asks the model (task catalog.import) for a draft;
// and writes it to src/catalog/types/_drafts/<key>.json for a person to review
// and move into the catalog by hand. Never scheduled. The logic lives in
// ./clawhub.ts.
//
// Needs ANTHROPIC_API_KEY (read from the environment or .env; never printed).

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileTypes } from "@/catalog/files";
import { claudeConfigured, claudeText } from "@/lib/llm/claude";
import { DRAFTS_DIR, ImportRefused, importClawhub, safe, type FetchLike } from "./clawhub";

const root = fileURLToPath(new URL("../../", import.meta.url));

async function main(): Promise<number> {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const envFile = path.join(root, ".env");
  if (existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      // An unreadable .env: the environment may still have the key.
    }
  }
  if (!claudeConfigured()) {
    console.error("ANTHROPIC_API_KEY is not set (in the environment or .env); the import needs the model.");
    return 1;
  }

  // Keys and aliases already taken: catalog files and drafts waiting for review.
  const taken = new Set(fileTypes().flatMap((d) => [d.key, ...d.aliases]));
  const drafts = path.join(root, DRAFTS_DIR);
  if (existsSync(drafts)) for (const f of readdirSync(drafts)) if (f.endsWith(".json")) taken.add(f.slice(0, -5));

  console.log(`Importing ${arg ?? "(no skill given)"} from ClawHub…`);
  try {
    const { file, definition, skill } = await importClawhub(arg, {
      fetch: fetch as unknown as FetchLike,
      model: async ({ system, user }) => (await claudeText({ task: "catalog.import", system, user, agent: "script:import-clawhub" })).text,
      root,
      taken,
      today: new Date().toISOString().slice(0, 10),
      log: (line) => console.log(safe(line)),
    });
    console.log(`Drafted “${safe(definition.title)}” (${definition.sections.length} sections) from ${skill.owner}/${skill.slug}@${safe(skill.version)}.`);
    console.log(`Wrote ${path.relative(root, file)}. Review it against the skill and our licensing rules before moving it into src/catalog/types/.`);
    return 0;
  } catch (error) {
    // Messages carry values from ClawHub; safe() again in case one was built without it.
    console.error(safe(error instanceof ImportRefused ? error.message : `The import failed: ${error instanceof Error ? error.message : String(error)}`));
    return 1;
  }
}

process.exit(await main());
