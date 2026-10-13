#!/usr/bin/env node
// Plays every full style (palettes marked ✦) through the real panel on one HTML file, in an isolated headless
// browser, and reports the font Chrome actually renders for headings, text and code, the block radius and the
// line height. It checks that each style renders its own Google fonts, that two passes in different orders give
// the same page, that undo returns to the original, and lists the elements that keep their own font.
// Read only: it never bakes, so the HTML file is left untouched.
//
// Usage: node tester-styles.cjs <file.html>
// Needs Playwright resolvable from this folder (`npm i playwright` in the skill folder). Windows uses the installed
// Chrome; elsewhere run `npx playwright install chromium`.
// Exit code 1 when a check fails.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, 'tweak.mjs');
const DATA = path.join(__dirname, '..', 'donnees');
const SETTLE_MS = 400; // lets a palette's Google stylesheet arrive before document.fonts.ready is awaited again
// One sample per kind of text the panel drives, plus form controls, which only follow the text font through a rule.
const PROBES = ['h1', 'h2', 'h3', 'p', 'li', 'td', 'blockquote', 'figcaption', 'code', 'pre', 'kbd', 'button', 'input', 'label'];

function loadPlaywright() {
  try { return require('playwright'); } catch { /* reported below */ }
  console.error('Playwright introuvable : lancer `npm i playwright` dans le dossier du skill (puis `npx playwright install chromium` hors Windows).');
  process.exit(2);
}

function startServer(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, file, '--no-open'], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.on('error', reject);
    child.stdout.once('data', (d) => {
      const first = JSON.parse(String(d).split('\n')[0]);
      first.ok ? resolve({ child, url: first.url }) : reject(new Error(first.error));
    });
  });
}

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.error('Usage : node tester-styles.cjs <fichier.html>'); process.exit(2); }
  const styled = JSON.parse(fs.readFileSync(path.join(DATA, 'palettes-integrees.json'), 'utf8')).palettes.filter((p) => p.style);
  if (!styled.length) { console.error('Aucun style complet (✦) dans le catalogue : importer d’abord un style, voir references/importer-un-style.md.'); process.exit(2); }
  const google = new Set(JSON.parse(fs.readFileSync(path.join(DATA, 'polices.json'), 'utf8')).google.familles.map((f) => f.famille));

  const { chromium } = loadPlaywright();
  const { child, url } = await startServer(path.resolve(file));
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  const failures = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => /changent la page|non initialisé/.test(document.querySelector('[data-tweak-host]')?.shadowRoot?.getElementById('status')?.textContent ?? ''), null, { timeout: 60000 });
    const inPanel = (js, arg) => page.evaluate(([js, arg]) => new Function('s', 'arg', js)(document.querySelector('[data-tweak-host]').shadowRoot, arg), [js, arg]);
    const status = await inPanel('return s.getElementById("status").textContent');
    if (/non initialisé/.test(status)) throw new Error(status);

    // Mark the samples once, so CDP can find the same nodes after every change.
    const probes = await page.evaluate((tags) => {
      const host = document.querySelector('[data-tweak-host]');
      const found = [];
      for (const tag of tags) {
        const visible = [...document.body.querySelectorAll(tag)].filter((n) => !host.contains(n) && n.getClientRects().length);
        // A body paragraph, not a short meta line set in another font.
        const e = tag === 'p' ? visible.find((n) => n.textContent.trim().length > 150) ?? visible[0] : visible[0];
        if (e) { e.setAttribute('data-tweak-probe', tag); found.push(tag); }
      }
      const rounded = [...document.body.querySelectorAll('*')].find((n) => !host.contains(n) && parseFloat(getComputedStyle(n).borderTopLeftRadius) > 0 && parseFloat(getComputedStyle(n).borderTopLeftRadius) < 100);
      rounded?.setAttribute('data-tweak-probe-radius', '');
      return found;
    }, PROBES);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    async function rendered(selector) {
      const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) return '';
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      return fonts.sort((a, b) => b.glyphCount - a.glyphCount)[0]?.familyName ?? '';
    }
    async function snap() {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(SETTLE_MS);
      await page.evaluate(() => document.fonts.ready);
      const fonts = {};
      for (const tag of probes) fonts[tag] = await rendered(`[data-tweak-probe="${tag}"]`);
      const extra = await page.evaluate(() => {
        const host = document.querySelector('[data-tweak-host]');
        const r = document.querySelector('[data-tweak-probe-radius]');
        const p = document.querySelector('[data-tweak-probe="p"]');
        // Computed family of every element holding text, to find the ones no style reaches.
        const families = [...document.body.querySelectorAll('*')]
          .filter((n) => !host.contains(n) && n.getClientRects().length && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()))
          .map((n) => getComputedStyle(n).fontFamily);
        return { radius: r ? getComputedStyle(r).borderTopLeftRadius : '-', line: p ? getComputedStyle(p).lineHeight : '-', families };
      });
      return { fonts, ...extra };
    }
    const apply = (nom) => inPanel('const b=[...s.querySelectorAll(".pcard")].find(b=>b.getAttribute("aria-label")==="Appliquer la palette "+arg); if(!b) throw new Error("Palette introuvable : "+arg); b.click()', nom);
    const signature = (s) => JSON.stringify([s.fonts, s.radius, s.line, s.families]);

    const original = await snap();
    const passes = [styled, [...styled].reverse()];
    const results = new Map();
    for (const [pass, order] of passes.entries()) {
      for (const p of order) {
        await apply(p.nom);
        const s = await snap();
        if (pass === 0) results.set(p.nom, s);
        else if (signature(s) !== signature(results.get(p.nom))) failures.push(`${p.nom} : rendu différent selon l'ordre de passage.`);
      }
    }
    for (let i = 0; i < 2 * styled.length; i++) await inPanel('s.getElementById("undo").click()');
    if (signature(await snap()) !== signature(original)) failures.push('Annuler jusqu\'au début ne rend pas le document d\'origine.');

    const head = probes.find((t) => /^h[1-3]$/.test(t));
    const cols = [head, 'p', 'code'].filter((t) => probes.includes(t));
    console.log(`Document : ${path.resolve(file)}`);
    console.log(`Échantillons : ${probes.join(', ')}\n`);
    console.log(['Style', ...cols.map((c) => `rendu ${c}`), 'arrondi', 'interligne'].join(' | '));
    console.log(['Original', ...cols.map((c) => original.fonts[c]), original.radius, original.line].join(' | '));
    for (const p of styled) {
      const s = results.get(p.nom);
      console.log([p.nom, ...cols.map((c) => s.fonts[c]), s.radius, s.line].join(' | '));
      const expect = { [head]: p.style.titres, p: p.style.texte, code: p.style.code };
      for (const c of cols) if (google.has(expect[c]) && s.fonts[c] !== expect[c]) failures.push(`${p.nom} : <${c}> rendu en ${s.fonts[c]}, attendu ${expect[c]}.`);
    }

    // Twins: styles that render the same three fonts, so switching between them changes no type.
    const byFonts = new Map();
    for (const p of styled) { const k = cols.map((c) => results.get(p.nom).fonts[c]).join(' / '); byFonts.set(k, [...(byFonts.get(k) ?? []), p.nom]); }
    const twins = [...byFonts].filter(([, names]) => names.length > 1);
    if (twins.length) console.log(`\nMême typographie rendue : ${twins.map(([k, n]) => `${n.join(', ')} (${k})`).join(' ; ')}`);

    const kept = probes.filter((t) => styled.every((p) => results.get(p.nom).fonts[t] === original.fonts[t]));
    if (kept.length) console.log(`Échantillons qu'aucun style ne change : ${kept.map((t) => `<${t}> ${original.fonts[t]}`).join(', ')}`);
    const stuck = original.families.filter((f, i) => styled.every((p) => results.get(p.nom).families[i] === f)).length;
    console.log(`Éléments de texte qu'aucun style ne change : ${stuck} sur ${original.families.length} (classe ou attribut style qui fixe sa propre police).`);
    if (pageErrors.length) failures.push(`Erreurs JavaScript dans la page : ${pageErrors.join(' ; ')}`);
  } finally {
    await browser.close();
    child.kill();
  }
  console.log(failures.length ? `\nÉCHEC\n- ${failures.join('\n- ')}` : '\nOK : chaque style rend ses polices, le rendu ne dépend pas de l\'ordre, annuler revient à l\'original.');
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => { console.error(`Test interrompu : ${error.message}`); process.exit(2); });
