// Contrôle avant commit : refuse un fichier indexé qui ressemble à un secret ou à un chemin sensible.
// Réutilise la détection du harness (~/.agents/harness/guardrails) ; les exceptions sont listées dans allowlist.txt.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const guardrails = join(homedir(), ".agents", "harness", "guardrails");
if (!existsSync(guardrails)) {
  console.error(`scan-secrets : ${guardrails} introuvable, commit refusé.`);
  process.exit(1);
}
const { findSecret } = await import(pathToFileURL(join(guardrails, "policy.mjs")));
const { classifySensitivePath } = await import(pathToFileURL(join(guardrails, "sensitive-paths.mjs")));

const allowFile = join(dirname(fileURLToPath(import.meta.url)), "allowlist.txt");
const allowed = new Set(existsSync(allowFile) ? readFileSync(allowFile, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")) : []);
const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);

const refused = [];
for (const path of staged) {
  if (allowed.has(path)) continue;
  const sensitive = classifySensitivePath(path);
  if (sensitive) {
    refused.push(`${path} : ${sensitive.kind}`);
    continue;
  }
  const content = execFileSync("git", ["show", `:${path}`], { maxBuffer: 64 * 1024 * 1024 });
  if (content.length > 5 * 1024 * 1024) refused.push(`${path} : plus de 5 Mo`);
  else if (!content.includes(0) && findSecret(content.toString("utf8"))) refused.push(`${path} : credential reconnu`);
}
if (refused.length) {
  console.error(`Commit refusé, ${refused.length} fichier(s) :\n${refused.map((line) => `  - ${line}`).join("\n")}\nRetirer le secret, ou ajouter un faux secret de test à .githooks/allowlist.txt.`);
  process.exit(1);
}
