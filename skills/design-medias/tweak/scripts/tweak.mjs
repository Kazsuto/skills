#!/usr/bin/env node
// Serves one local HTML file with the tweak panel injected, then bakes the chosen values into the source.
// The browser only changes the DOM; every write happens here, from the file on disk, so the baked HTML
// never carries the panel, the picking attributes or DOM changes made by the page's own scripts.
//
// Usage: node tweak.mjs <file.html> [--explore] [--no-open] [--port <n>]
// Prints one JSON line when the server is ready, and one JSON line when the session ends.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_FILE = path.join(HERE, 'panel.js');
const DATA_DIR = path.join(HERE, '..', 'donnees');
const BUILTIN_PALETTES = path.join(DATA_DIR, 'palettes-integrees.json');
const USER_PALETTES = path.join(DATA_DIR, 'mes-palettes.json');
const ROLE_MAPPINGS = path.join(DATA_DIR, 'correspondances.json');
const FONT_CATALOG = path.join(DATA_DIR, 'polices.json');
const IDLE_LIMIT_MS = 3 * 60 * 60 * 1000; // a hand-tuning session rarely lasts hours; frees the port if forgotten
const MAX_BODY_BYTES = 1024 * 1024; // a bake payload is a few kilobytes; anything larger is not ours
const MAX_VALUE_LENGTH = 300; // longest custom property value accepted from the panel
const MAX_USER_PALETTES = 200; // far above real use; stops a runaway script from filling the file
const FONT_CSS_TIMEOUT_MS = 15000;
const FONT_FILE_TIMEOUT_MS = 30000;
// A current desktop Chrome user agent makes the Google Fonts API answer with WOFF2 files.
const GOOGLE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const KEPT_SUBSETS = new Set(['latin', 'latin-ext']); // French text; other scripts would only add weight to the file
const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([^;{}<>()]{1,80}\))$/i;
const ROLE_IDS = new Set(['background', 'surface', 'surfaceTint', 'surfaceStrong', 'text', 'textMuted', 'border',
  'borderStrong', 'primary', 'accent', 'success', 'warning', 'error', 'onStrong', 'onPrimary']);
const FONTS_START = '/* tweak:polices */';
const FONTS_END = '/* /tweak:polices */';
// Rules the bake may add, keyed by the variable that drives them. Fixed text: the panel never sends CSS rules,
// it previews these same rules, served with the data. Text blocks only: tables, headings and code keep their own setting.
// Heading and code fonts are a deliberate choice, so they win over a class that sets its own font. {extra} lists the
// display classes found by the panel (--tweak-heading-extra), such as a chapter number beside its title.
const TEXT_BLOCKS = 'p, li, dd, blockquote, figcaption';
const HEADING_EXTRA_VAR = '--tweak-heading-extra';
const CLASS_LIST_RE = /^[A-Za-z_][\w-]*( [A-Za-z_][\w-]*){0,11}$/;
const FIXED_RULES = {
  '--tweak-font-heading': 'h1, h2, h3, h4, h5, h6{extra} { font-family: var(--tweak-font-heading) !important; }',
  // Form controls do not inherit the page font by default.
  '--tweak-font-body': 'body { font-family: var(--tweak-font-body); } button, input, select, textarea { font-family: inherit; }',
  '--tweak-font-code': 'code, kbd, samp, pre { font-family: var(--tweak-font-code) !important; }',
  '--tweak-text-align': `${TEXT_BLOCKS} { text-align: var(--tweak-text-align); }`,
  '--tweak-hyphens': `${TEXT_BLOCKS} { -webkit-hyphens: var(--tweak-hyphens); hyphens: var(--tweak-hyphens); }`,
  '--tweak-text-wrap': `${TEXT_BLOCKS} { text-wrap: var(--tweak-text-wrap); }`,
};

// Elements the panel can hide. They always have a closing tag, so their source span can be found
// by counting nesting. <p> and <li> are left out because HTML lets their closing tag be omitted.
const HIDEABLE = new Set(['section', 'article', 'aside', 'header', 'footer', 'nav', 'figure', 'table',
  'div', 'blockquote', 'pre', 'ul', 'ol', 'dl', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
// Elements whose content is raw text: a "<" inside them is not a tag.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const OVERRIDE_BLOCK_RE = /<style id="tweak-overrides">[\s\S]*?<\/style>\n?/i;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

function parseArgs(argv) {
  const args = { file: null, explore: false, open: true, port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--explore') args.explore = true;
    else if (a === '--no-open') args.open = false;
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a.startsWith('--')) fail(`Option inconnue : ${a}. Options : --explore, --no-open, --port <n>.`);
    else if (args.file) fail('Un seul fichier HTML par session.');
    else args.file = a;
  }
  if (!args.file) fail('Usage : node tweak.mjs <fichier.html> [--explore] [--no-open] [--port <n>]');
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) fail('Port invalide.');
  return args;
}

// Lists opening and closing tags outside comments and raw-text elements, with their source offsets.
function scanTags(src) {
  const tags = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(src))) {
    if (m[0].startsWith('<!--')) continue;
    const name = m[2].toLowerCase();
    const closing = m[1] === '/';
    tags.push({ name, closing, start: m.index, end: TAG_RE.lastIndex, selfClosing: /\/\s*$/.test(m[3]) });
    if (!closing && RAW_TEXT.has(name)) {
      const closeRe = new RegExp(`</${name}\\s*>`, 'ig');
      closeRe.lastIndex = TAG_RE.lastIndex;
      const close = closeRe.exec(src);
      if (!close) break;
      TAG_RE.lastIndex = close.index;
    }
  }
  return tags;
}

// Hideable opening tags inside <body>, in document order. Their index is the id the panel sends back.
function hideableTags(tags) {
  const bodyIndex = tags.findIndex((t) => t.name === 'body' && !t.closing);
  return tags
    .map((t, index) => ({ ...t, index }))
    .filter((t) => t.index > bodyIndex && !t.closing && !t.selfClosing && HIDEABLE.has(t.name));
}

function elementEnd(tags, openIndex) {
  const name = tags[openIndex].name;
  let depth = 0;
  for (let j = openIndex; j < tags.length; j++) {
    const t = tags[j];
    if (t.name !== name || t.selfClosing) continue;
    depth += t.closing ? -1 : 1;
    if (depth === 0) return t.end;
  }
  return -1;
}

function lastMatchIndex(src, re) {
  let found = null;
  let m;
  const global = new RegExp(re.source, 'ig');
  while ((m = global.exec(src))) found = m;
  return found;
}

function readSource(file) {
  const bytes = fs.readFileSync(file);
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = bytes.toString('utf8', hasBom ? 3 : 0);
  return { text, hasBom, hash: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function servedHtml(src, token, mode) {
  const tags = scanTags(src);
  const edits = hideableTags(tags).map((t, id) => ({ at: t.start + 1 + t.name.length, text: ` data-tweak-id="${id}"` }));
  const bodyClose = lastMatchIndex(src, /<\/body\s*>/);
  const script = `<script src="/${token}/__tweak/panel.js" data-tweak-token="${token}" data-tweak-mode="${mode}"></script>`;
  edits.push({ at: bodyClose ? bodyClose.index : src.length, text: script });
  edits.sort((a, b) => b.at - a.at);
  let out = src;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Never reuse a name: two bakes within the same second must not overwrite the first backup.
function uniquePath(dir, stem, ext) {
  let candidate = path.join(dir, `${stem}${ext}`);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${stem}-${n}${ext}`);
  return candidate;
}

function validatePayload(body, hideableCount) {
  if (!body || typeof body !== 'object') throw new Error('Contenu de Bake illisible.');
  const overrides = body.overrides ?? {};
  if (typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Valeurs de Bake invalides.');
  for (const [name, value] of Object.entries(overrides)) {
    if (!/^--[\w-]+$/.test(name)) throw new Error(`Nom de variable refusé : ${name}`);
    // A value must stay inside its declaration: no way to close the rule, the block or the <style> element.
    if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH || /[;{}<>]/.test(value) || !value.trim()) {
      throw new Error(`Valeur refusée pour ${name}.`);
    }
    if (name === HEADING_EXTRA_VAR && !CLASS_LIST_RE.test(value)) throw new Error(`Classes refusées pour ${name}.`);
  }
  const hidden = body.hidden ?? [];
  if (!Array.isArray(hidden) || hidden.some((id) => !Number.isInteger(id) || id < 0 || id >= hideableCount)) {
    throw new Error('Liste de sections masquées invalide.');
  }
  const catalog = readDataFile(FONT_CATALOG).google.familles;
  const googleFonts = body.googleFonts ?? [];
  if (!Array.isArray(googleFonts) || googleFonts.some((f) => !catalog.some((c) => c.famille === f))) {
    throw new Error('Police Google hors du catalogue de tweak.');
  }
  return { overrides, hidden: [...new Set(hidden)], googleFonts: [...new Set(googleFonts)] };
}

// The override block has three parts: embedded fonts, the :root variables, and the fixed rules.
function parseOverrideBlock(src) {
  const block = src.match(OVERRIDE_BLOCK_RE)?.[0] ?? '';
  const vars = {};
  const root = block.match(/:root\s*\{([^}]*)\}/);
  if (root) for (const m of root[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  const fontSection = block.includes(FONTS_START) ? block.slice(block.indexOf(FONTS_START), block.indexOf(FONTS_END)) : '';
  const faces = [...fontSection.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => ({
    family: m[0].match(/font-family:\s*'([^']+)'/)?.[1] ?? '', css: m[0],
  }));
  return { vars, faces };
}

function overrideBlock(vars, faces) {
  const parts = ['<style id="tweak-overrides">', '/* tweak : valeurs réglées à la main. Relancer tweak sur ce fichier pour les modifier. */'];
  if (faces.length) parts.push(FONTS_START, ...faces.map((f) => f.css), FONTS_END);
  parts.push(':root {', ...Object.entries(vars).map(([name, value]) => `  ${name}: ${value};`), '}');
  const extra = CLASS_LIST_RE.test(vars[HEADING_EXTRA_VAR] ?? '') ? vars[HEADING_EXTRA_VAR].split(' ').map((c) => `, .${c}`).join('') : '';
  for (const [name, rule] of Object.entries(FIXED_RULES)) if (vars[name]) parts.push(rule.replace('{extra}', extra));
  parts.push('</style>');
  return `${parts.join('\n')}\n`;
}

async function fetchChecked(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { 'User-Agent': GOOGLE_UA }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} pour ${url}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// Downloads one catalogue family (latin and latin-ext, 400 to 700, italic 400 when it exists) and returns
// self-contained @font-face rules. Google serves variable fonts: one file covers several weights, so faces
// sharing a file are merged into one rule with a weight range instead of embedding the same file three times.
async function embedGoogleFont(family) {
  const entry = readDataFile(FONT_CATALOG).google.familles.find((f) => f.famille === family);
  const axes = entry.italique ? 'ital,wght@0,400;0,600;0,700;1,400' : 'wght@400;600;700';
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${axes}&display=swap`;
  const css = await (await fetchChecked(cssUrl, FONT_CSS_TIMEOUT_MS)).text();
  const groups = new Map();
  for (const [, subset, face] of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)) {
    if (!KEPT_SUBSETS.has(subset)) continue;
    const url = face.match(/url\((https:[^)]+)\)/)?.[1];
    if (!url || new URL(url).hostname !== 'fonts.gstatic.com') throw new Error(`Police ${family} : adresse de fichier inattendue.`);
    const style = face.match(/font-style:\s*(\w+)/)?.[1] ?? 'normal';
    const weight = Number(face.match(/font-weight:\s*(\d+)/)?.[1] ?? 400);
    const range = face.match(/unicode-range:\s*([^;]+);/)?.[1] ?? '';
    const key = `${url}|${style}`;
    const group = groups.get(key) ?? { url, style, range, weights: [] };
    group.weights.push(weight);
    groups.set(key, group);
  }
  if (!groups.size) throw new Error(`Police ${family} : aucun fichier latin reçu de Google Fonts.`);
  const faces = [];
  for (const g of groups.values()) {
    const bytes = Buffer.from(await (await fetchChecked(g.url, FONT_FILE_TIMEOUT_MS)).arrayBuffer());
    const weight = Math.min(...g.weights) === Math.max(...g.weights) ? g.weights[0] : `${Math.min(...g.weights)} ${Math.max(...g.weights)}`;
    faces.push({ family, css: `@font-face { font-family: '${family}'; font-style: ${g.style}; font-weight: ${weight}; font-display: swap; src: url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2'); unicode-range: ${g.range}; }` });
  }
  return faces;
}

// Keeps the embedded faces still named by a variable, adds the newly requested families.
async function finalFaces(existing, vars, googleFonts) {
  const used = Object.values(vars).join(' ');
  const kept = existing.filter((f) => f.family && used.includes(f.family) && !googleFonts.includes(f.family));
  const added = [];
  for (const family of googleFonts) {
    if (!used.includes(family)) continue;
    try {
      added.push(...await embedGoogleFont(family));
    } catch (error) {
      throw new Error(`Police ${family} non intégrée (${error.message}). Vérifie la connexion ou choisis une police locale.`);
    }
  }
  return [...kept, ...added];
}

// Widens a removed span to its whole line when nothing else shares that line, so no blank line is left behind.
function wholeLine(src, start, end) {
  const lineStart = src.lastIndexOf('\n', start - 1) + 1;
  const newline = src.indexOf('\n', end);
  const lineEnd = newline === -1 ? src.length : newline + 1;
  const alone = !src.slice(lineStart, start).trim() && !src.slice(end, lineEnd).trim();
  return alone ? { start: lineStart, end: lineEnd } : { start, end };
}

function readDataFile(file, fallback) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Fichier de données introuvable : ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Builds the baked HTML from the source text: removes the hidden elements and writes one override block
// after the last <style> element, so it wins over every earlier :root declaration of the same variable.
function bake(src, hidden, merged, faces) {
  const tags = scanTags(src);
  const hideable = hideableTags(tags);
  const spans = hidden.map((id) => {
    const t = hideable[id];
    const end = elementEnd(tags, t.index);
    if (end === -1) throw new Error(`Balise de fermeture introuvable pour l'élément <${t.name}> n° ${id} : masque plutôt son parent.`);
    return { start: t.start, end, name: t.name };
  });
  const outer = spans.filter((s) => !spans.some((o) => o !== s && o.start <= s.start && o.end >= s.end));

  const edits = outer.map((s) => ({ ...wholeLine(src, s.start, s.end), text: '' }));
  const block = Object.keys(merged).length || faces.length ? overrideBlock(merged, faces) : '';
  const current = src.match(OVERRIDE_BLOCK_RE);
  if (current) {
    edits.push({ start: current.index, end: current.index + current[0].length, text: block });
  } else if (block) {
    const styleCloses = tags.filter((t) => t.name === 'style' && t.closing);
    const headClose = tags.find((t) => t.name === 'head' && t.closing);
    const at = styleCloses.length ? styleCloses[styleCloses.length - 1].end : headClose ? headClose.start : 0;
    edits.push({ start: at, end: at, text: styleCloses.length ? `\n${block.trimEnd()}` : block });
  }

  edits.sort((a, b) => b.start - a.start);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].end > edits[i - 1].start) throw new Error('Le bloc de valeurs tomberait dans une section masquée : affiche-la ou masque une autre section.');
  }
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { html: out, removed: outer.length, overrideCount: Object.keys(merged).length, fonts: [...new Set(faces.map((f) => f.family))] };
}

function writeAtomic(target, text, hasBom) {
  const tmp = `${target}.tweak-tmp`;
  fs.writeFileSync(tmp, (hasBom ? '﻿' : '') + text, 'utf8');
  fs.renameSync(tmp, target);
}

function validPalette(p) {
  if (!p || typeof p !== 'object') throw new Error('Palette illisible.');
  if (typeof p.id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(p.id)) throw new Error('Identifiant de palette invalide.');
  if (typeof p.nom !== 'string' || !p.nom.trim() || p.nom.length > 60 || /[<>]/.test(p.nom)) {
    throw new Error('Nom de palette invalide : 1 à 60 caractères, sans < ni >.');
  }
  const roles = {};
  for (const [role, value] of Object.entries(p.roles ?? {})) {
    if (!ROLE_IDS.has(role) || role === 'onStrong' || role === 'onPrimary') throw new Error(`Rôle inconnu : ${role}`);
    if (typeof value !== 'string' || !COLOR_RE.test(value.trim())) throw new Error(`Couleur invalide pour le rôle ${role}.`);
    roles[role] = value.trim();
  }
  if (!Object.keys(roles).length) throw new Error('Une palette a besoin d\'au moins une couleur.');
  return { id: p.id, nom: p.nom.trim(), roles };
}

function savePalettes(body) {
  const data = readDataFile(USER_PALETTES, { palettes: [] });
  if (body.action === 'enregistrer') {
    const palette = validPalette(body.palette);
    if (readDataFile(BUILTIN_PALETTES).palettes.some((p) => p.id === palette.id)) {
      throw new Error('Une palette intégrée ne se modifie pas : enregistre une copie sous un autre nom.');
    }
    const index = data.palettes.findIndex((p) => p.id === palette.id);
    if (index >= 0) data.palettes[index] = { ...data.palettes[index], ...palette };
    else if (data.palettes.length >= MAX_USER_PALETTES) throw new Error('Trop de palettes enregistrées.');
    else data.palettes.push({ ...palette, creeLe: new Date().toISOString().slice(0, 10) });
  } else if (body.action === 'supprimer') {
    data.palettes = data.palettes.filter((p) => p.id !== body.palette?.id);
  } else {
    throw new Error('Action inconnue sur les palettes.');
  }
  writeAtomic(USER_PALETTES, `${JSON.stringify(data, null, 2)}\n`, false);
  return data.palettes;
}

// Remembers which document variable plays which colour role, per design system, so the next session on a
// document of the same family applies palettes without re-mapping.
function saveMapping(body) {
  if (typeof body.cle !== 'string' || !body.cle || body.cle.length > 120 || /[<>]/.test(body.cle)) throw new Error('Clé de correspondance invalide.');
  const roles = {};
  for (const [name, role] of Object.entries(body.roles ?? {})) {
    if (!/^--[\w-]+$/.test(name) || !ROLE_IDS.has(role)) throw new Error(`Correspondance refusée : ${name} → ${role}`);
    roles[name] = role;
  }
  const data = readDataFile(ROLE_MAPPINGS, {});
  data[body.cle] = roles;
  writeAtomic(ROLE_MAPPINGS, `${JSON.stringify(data, null, 2)}\n`, false);
  return roles;
}

function proposalMarkdown(file, body, essaiName) {
  const rows = Object.entries(body.overrides ?? {}).map(([name, value]) =>
    `| \`${name}\` | \`${body.initial?.[name] ?? '?'}\` | \`${value}\` |`);
  const contrast = Array.isArray(body.contrast) && body.contrast.length
    ? body.contrast.map((c) => `- ${String(c)}`).join('\n')
    : '- Aucun texte sous le seuil de contraste dans le rendu final.';
  const hiddenLabels = Array.isArray(body.hiddenLabels) && body.hiddenLabels.length
    ? body.hiddenLabels.map((l) => `- ${String(l)}`).join('\n') : '- Aucune.';
  const palette = body.palette ? `Palette : ${String(body.palette).slice(0, 80)}\n` : '';
  const fonts = Array.isArray(body.fontSummary) && body.fontSummary.length
    ? `Polices : ${body.fontSummary.map((f) => String(f).slice(0, 120)).join(' ; ')}\n` : '';
  return `# Proposition de réglages\n\nDocument testé : \`${file}\`\nEssai rendu : \`${essaiName}\`\nLe document d'origine n'a pas été modifié.\n${palette}${fonts}\n## Variables\n\n| Variable | Avant | Proposé |\n| --- | --- | --- |\n${rows.join('\n') || '| (aucune) | | |'}\n\n## Contraste\n\n${contrast}\n\n## Sections masquées dans l'essai\n\n${hiddenLabels}\n`;
}

function openBrowser(url) {
  // rundll32 hands the URL to the default browser without going through cmd quoting rules.
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => console.error(`Navigateur non ouvert automatiquement : ouvre ${url}`));
  child.unref();
}

const args = parseArgs(process.argv.slice(2));
const file = path.resolve(args.file);
if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`Fichier introuvable : ${file}`);
if (!/\.html?$/i.test(file)) fail('Le fichier doit être un .html ou .htm.');
if (!fs.existsSync(PANEL_FILE)) fail(`Panneau introuvable : ${PANEL_FILE}`);

const docDir = path.dirname(file);
const docName = path.basename(file);
const baseName = docName.replace(/\.html?$/i, '');
const workDir = path.join(docDir, `${baseName}.tweak`);
const token = crypto.randomBytes(18).toString('base64url');
const mode = args.explore ? 'explore' : 'normal';
let servedHash = null;
let idleTimer = null;

function finish(summary) {
  console.log(JSON.stringify(summary));
  server.close();
  setTimeout(() => process.exit(0), 200);
}

function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => finish({ ok: true, ended: 'idle', changed: false, file }), IDLE_LIMIT_MS);
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('Contenu trop volumineux.')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('JSON invalide.')); }
    });
    req.on('error', reject);
  });
}

async function handleBake(req, res) {
  const body = await readJson(req);
  const source = readSource(file);
  if (source.hash !== servedHash) {
    throw new Error('Le fichier a changé sur le disque depuis l\'ouverture : recharge la page, puis refais tes réglages.');
  }
  const payload = validatePayload(body, hideableTags(scanTags(source.text)).length);
  const existing = parseOverrideBlock(source.text);
  const merged = { ...existing.vars, ...payload.overrides };
  const faces = await finalFaces(existing.faces, merged, payload.googleFonts);
  const result = bake(source.text, payload.hidden, merged, faces);
  const written = [];
  if (mode === 'normal') {
    const backupDir = path.join(workDir, 'sauvegardes');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = uniquePath(backupDir, `${baseName}.${stamp()}`, '.html');
    fs.copyFileSync(file, backup);
    writeAtomic(file, result.html, source.hasBom);
    written.push(file);
    return { ok: true, ended: 'bake', mode, changed: true, file, backup, written, overrides: result.overrideCount, removed: result.removed, fonts: result.fonts };
  }
  fs.mkdirSync(workDir, { recursive: true });
  const id = stamp();
  // The trial copy sits next to the document so its relative assets still resolve.
  const essai = uniquePath(docDir, `${baseName}.essai-${id}`, '.html');
  const proposal = uniquePath(workDir, `proposition-${id}`, '.md');
  writeAtomic(essai, result.html, source.hasBom);
  writeAtomic(proposal, proposalMarkdown(file, body, path.basename(essai)), false);
  written.push(essai, proposal);
  return { ok: true, ended: 'bake', mode, changed: false, file, essai, proposal, written, overrides: result.overrideCount, removed: result.removed, fonts: result.fonts };
}

function serveStatic(rel, res) {
  const target = path.resolve(docDir, rel);
  const inside = path.relative(docDir, target);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return send(res, 404, 'text/plain', 'Introuvable');
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return send(res, 404, 'text/plain', 'Introuvable');
  send(res, 200, MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream', fs.readFileSync(target));
}

const server = http.createServer(async (req, res) => {
  resetIdle();
  const url = new URL(req.url, 'http://127.0.0.1');
  const prefix = `/${token}/`;
  // Every route sits under the random token, so no other local page or process can guess a URL.
  if (!url.pathname.startsWith(prefix)) return send(res, 404, 'text/plain', 'Introuvable');
  let rel;
  try { rel = decodeURIComponent(url.pathname.slice(prefix.length)); } catch { return send(res, 400, 'text/plain', 'Chemin invalide'); }

  if (req.method === 'POST' && rel === '__tweak/bake') {
    try {
      const summary = await handleBake(req, res);
      send(res, 200, 'application/json', JSON.stringify(summary));
      finish(summary);
    } catch (error) {
      send(res, 400, 'application/json', JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (req.method === 'POST' && (rel === '__tweak/palettes' || rel === '__tweak/correspondance')) {
    try {
      const body = await readJson(req);
      const result = rel === '__tweak/palettes' ? { palettes: savePalettes(body) } : { roles: saveMapping(body) };
      send(res, 200, 'application/json', JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      send(res, 400, 'application/json', JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (req.method === 'GET' && rel === '__tweak/donnees') {
    try {
      return send(res, 200, 'application/json', JSON.stringify({
        ok: true,
        integrees: readDataFile(BUILTIN_PALETTES).palettes,
        mes: readDataFile(USER_PALETTES, { palettes: [] }).palettes,
        correspondances: readDataFile(ROLE_MAPPINGS, {}),
        polices: readDataFile(FONT_CATALOG),
        regles: FIXED_RULES,
      }));
    } catch (error) {
      return send(res, 500, 'application/json', JSON.stringify({ ok: false, error: error.message }));
    }
  }
  if (req.method === 'POST' && rel === '__tweak/exit') {
    send(res, 200, 'application/json', JSON.stringify({ ok: true }));
    return finish({ ok: true, ended: 'exit', changed: false, file });
  }
  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Méthode refusée');
  if (rel === '__tweak/panel.js') return send(res, 200, MIME['.js'], fs.readFileSync(PANEL_FILE));
  if (rel === docName) {
    const source = readSource(file);
    servedHash = source.hash;
    return send(res, 200, MIME['.html'], servedHtml(source.text, token, mode));
  }
  serveStatic(rel, res);
});

server.on('error', (error) => fail(`Serveur non démarré : ${error.message}`));
// Loopback only: the page and its write endpoint are never reachable from the network.
server.listen(args.port, '127.0.0.1', () => {
  const pageUrl = `http://127.0.0.1:${server.address().port}/${token}/${encodeURIComponent(docName)}`;
  console.log(JSON.stringify({ ok: true, ready: true, url: pageUrl, file, mode }));
  resetIdle();
  if (args.open) openBrowser(pageUrl);
});
