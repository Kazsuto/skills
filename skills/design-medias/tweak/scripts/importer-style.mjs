// Imports one Refero Styles page (public, no account) into donnees/styles/<slug>/ so a palette or a full style can be
// built from the brand's own measured tokens instead of second-hand hex codes.
// Usage: node importer-style.mjs <https://styles.refero.design/style/UUID | UUID> [--slug nom]
// Writes style.json (the structured style Refero generates its files from), mesures.json (colours, radii and type
// measured on the live site), design-md.txt (the DESIGN.md), variables.css and source.json, then prints a summary for role mapping.
// One page per call: the site asks AI crawlers not to crawl it, so never loop this over the sitemap.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STYLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'donnees', 'styles');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const USER_AGENT = 'tweak-skill/1.0 (import ponctuel d\'un style, usage personnel)';
const TIMEOUT_MS = 20000;

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

// Returns the JSON object literal that encloses the first occurrence of needle.
function objectAround(text, needle) {
  const at = text.indexOf(needle);
  if (at < 0) return null;
  let depth = 0;
  let start = at;
  for (; start >= 0; start--) {
    if (text[start] === '}') depth++;
    else if (text[start] === '{') { if (depth === 0) break; depth--; }
  }
  let inString = false;
  for (let i = start, d = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{') d++;
    else if (c === '}' && --d === 0) return JSON.parse(text.slice(start, i + 1));
  }
  return null;
}

const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, '\'').replace(/&#39;/g, '\'')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&');

const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const slugArg = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : null;
const uuid = target?.match(UUID_RE)?.[0];
if (!uuid || (target.includes('://') && !target.startsWith('https://styles.refero.design/style/'))) {
  fail('Donne une URL https://styles.refero.design/style/<UUID> ou l\'UUID seul. Pour trouver la page d\'une marque : recherche web « <marque> design system » limitée à styles.refero.design.');
}
const url = `https://styles.refero.design/style/${uuid}`;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
let html;
try {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
  if (!response.ok) fail(`Refero a répondu ${response.status} pour ${url}.`);
  html = await response.text();
} catch (error) {
  fail(`Page Refero injoignable (${error.name === 'AbortError' ? 'délai dépassé' : error.message}).`);
} finally {
  clearTimeout(timer);
}

// The page streams its data as React Server Component chunks: concatenated, they hold the style objects as JSON.
const payload = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map((m) => JSON.parse(m[1])).join('');
const style = objectAround(payload, '"surfaces":[');
if (!style?.colors) fail('Objet de style introuvable dans la page : Refero a peut-être changé son format.');
const mesures = objectAround(payload, '"colors":{"tokens"');
const code = html.match(/<code class="text-foreground">([\s\S]*?)<\/code>/);
const designMd = code ? decodeEntities(code[1]) : '';
const css = designMd.match(/```css\n([\s\S]*?)```/)?.[1] ?? '';
const titre = decodeEntities(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '').replace(/\s*[|·–—-]\s*Refero.*$/i, '').trim();
const nom = designMd.match(/^# (.+?) [—–-] Style Reference/m)?.[1] ?? titre.replace(/ design system$/i, '');
const slug = slugify(slugArg || nom || uuid);

const dir = path.join(STYLES_DIR, slug);
fs.mkdirSync(dir, { recursive: true });
const write = (name, content) => { if (content) fs.writeFileSync(path.join(dir, name), content); };
write('style.json', `${JSON.stringify(style, null, 2)}\n`);
write('mesures.json', mesures ? `${JSON.stringify(mesures, null, 2)}\n` : '');
write('design-md.txt', designMd); // raw DESIGN.md, kept as data rather than skill instructions
write('variables.css', css);
write('source.json', `${JSON.stringify({ url, nom, titre, importeLe: new Date().toISOString().slice(0, 10) }, null, 2)}\n`);

// Summary for the role mapping: what each colour is for, surfaces by level, measured text/background pairs, type, shape.
const pairs = (mesures?.colors?.contrastPairs ?? []).slice(0, 8).map((p) => `${p.foreground} sur ${p.background} : ${p.ratio}`);
const usage = (mesures?.colors?.tokens ?? []).slice(0, 12).map((t) => `${t.hex} ×${t.frequency} ${(t.properties ?? []).join('/')} (${(t.contexts ?? []).join(', ')})`);
console.log(JSON.stringify({
  ok: true,
  dossier: dir,
  nom,
  theme: style.theme,
  caractere: style.northStar,
  couleurs: style.colors.map((c) => `${c.hex} ${c.name} [${c.group ?? ''}] ${c.role ?? ''}`),
  surfaces: (style.surfaces ?? []).map((s) => `${s.level}: ${s.hex} ${s.name}, ${s.purpose}`),
  usageMesure: usage,
  contrastesMesures: pairs,
  polices: (style.typography ?? []).map((t) => `${t.family} (${t.weight}) → remplaçante : ${t.substitute ?? 'aucune'} · ${t.role ?? ''}`),
  corpsDeTexte: (style.typeScale ?? []).filter((t) => /body/.test(t.role)),
  arrondis: style.spacing?.radius ?? null,
  fichiers: fs.readdirSync(dir),
}, null, 2));
