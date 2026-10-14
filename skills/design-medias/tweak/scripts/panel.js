// Tweak panel, injected by tweak.mjs. A local design panel for one HTML document: palettes applied in one
// click through colour roles, global typography and spacing controls, section hiding, contrast checks,
// undo/redo, then a bake through the server. It only changes the DOM: the server writes from the source
// file, so nothing added here (panel, attributes, inline styles, preview links) reaches the saved HTML.
(() => {
  const script = document.currentScript;
  const token = script.dataset.tweakToken;
  const mode = script.dataset.tweakMode === 'explore' ? 'explore' : 'normal';
  const api = (route) => `/${token}/__tweak/${route}`;
  const root = document.documentElement;
  const docName = decodeURIComponent(location.pathname.split('/').pop() || 'document');

  const CONTRAST_NORMAL = 4.5; // WCAG AA for body text
  const CONTRAST_LARGE = 3; // WCAG AA for text from 24 px, or from 18.66 px when bold
  const RECHECK_DELAY_MS = 250; // waits for a slider drag to settle before walking the whole page again
  const CONFIRM_WINDOW_MS = 5000; // a second click within this delay confirms a write, a delete or an exit
  const MEASURE_BATCH = 15; // variables measured between two paints, so the page stays responsive
  const PANEL_WIDTH = 372;
  const DOCK_MIN_VIEWPORT = 1000; // below this width the panel floats over the page instead of pushing it
  const FORBIDDEN = /[;{}<>]/; // the server refuses these characters: they could close the CSS rule
  const CSS_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'currentcolor']);
  const LENGTH_RE = /^(-?\d*\.?\d+)(px|rem|em|mm|cm|pt|pc|in|q|%|vw|vh|vmin|vmax|ch|ex)$/i;
  const NUMBER_RE = /^-?\d*\.?\d+$/;
  const FONT_VAR_HEADING = '--tweak-font-heading';
  const FONT_VAR_BODY = '--tweak-font-body';
  const FONT_VAR_CODE = '--tweak-font-code';
  // Classes of large display text outside h1-h6 (a chapter number), which take the heading font too.
  const HEADING_EXTRA_VAR = '--tweak-heading-extra';
  const ALIGN_VAR = '--tweak-text-align';
  const HYPHENS_VAR = '--tweak-hyphens';
  const WRAP_VAR = '--tweak-text-wrap';
  // Comfortable measure for body text, in characters per line with spaces (Butterick, Practical Typography).
  const MEASURE_MIN = 45;
  const MEASURE_MAX = 90;
  const MARGIN_TOLERANCE = 0.2; // left and right text margins further apart than this read as lopsided

  const ROLES = [
    { id: 'background', label: 'Fond' },
    { id: 'surface', label: 'Surface' },
    { id: 'surfaceTint', label: 'Fond teinté' },
    { id: 'surfaceStrong', label: 'Aplat foncé' },
    { id: 'border', label: 'Filets' },
    { id: 'borderStrong', label: 'Contour marqué' },
    { id: 'text', label: 'Texte', against: 'background' },
    { id: 'textMuted', label: 'Texte secondaire', against: 'background' },
    { id: 'primary', label: 'Primaire', against: 'background' },
    { id: 'accent', label: 'Accent', against: 'background' },
    { id: 'success', label: 'Succès', against: 'background' },
    { id: 'warning', label: 'Alerte', against: 'background' },
    { id: 'error', label: 'Erreur', against: 'background' },
    { id: 'onStrong', label: 'Texte sur aplat', against: 'surfaceStrong' },
    { id: 'onPrimary', label: 'Texte sur primaire', against: 'primary' },
  ];
  const ROLE_BY_ID = new Map(ROLES.map((r) => [r.id, r]));

  const pageStyle = document.createElement('style');
  pageStyle.setAttribute('data-tweak', '');
  pageStyle.textContent = `[data-tweak-hidden]{display:none!important}
[data-tweak-hover]{outline:2px dashed #d9480f!important;outline-offset:2px!important;cursor:crosshair!important}
[data-tweak-flash]{outline:3px solid #d9480f!important;outline-offset:3px!important}
@media screen{html[data-tweak-docked]{padding-right:${PANEL_WIDTH + 16}px!important}}
@media print{[data-tweak-host]{display:none!important}}`;
  document.head.appendChild(pageStyle);
  // Live preview of the fixed rules the bake would add, as served by the server that writes them.
  const fixedRuleStyle = document.createElement('style');
  fixedRuleStyle.setAttribute('data-tweak', '');
  document.head.appendChild(fixedRuleStyle);

  // ---------- colours ----------
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  function rgba(color) {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  }
  const hex = (c) => `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
  function luminance(c) {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const contrastOf = (fg, bg) => {
    const back = over(rgba(bg), [255, 255, 255, 1]);
    return ratio(over(rgba(fg), back), back);
  };
  const fr = (n, digits = 1) => n.toFixed(digits).replace('.', ',');
  const isColor = (v) => !!v && !FORBIDDEN.test(v) && CSS.supports('color', v);

  // ---------- variables ----------
  function classify(value) {
    if (NUMBER_RE.test(value)) return 'number';
    if (LENGTH_RE.test(value)) return 'length';
    if (!CSS_KEYWORDS.has(value.toLowerCase()) && CSS.supports('color', value)) return 'color';
    return 'other';
  }

  function collectRootVars() {
    const names = [];
    const seen = new Set();
    const derived = new Set();
    let unreadable = 0;
    const isRoot = (rule) => rule.selectorText.split(',').some((s) => [':root', 'html'].includes(s.trim()));
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          if (!isRoot(rule)) continue;
          for (const prop of rule.style) {
            if (prop.startsWith('--') && !prop.startsWith('--tweak-') && !seen.has(prop)) { seen.add(prop); names.push(prop); }
            if (/var\(/.test(rule.style.getPropertyValue(prop))) derived.add(prop);
          }
        } else if (rule instanceof CSSMediaRule) {
          if (matchMedia(rule.media.mediaText).matches) visit(rule.cssRules);
        } else if (rule instanceof CSSSupportsRule || (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule)) {
          visit(rule.cssRules);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode?.hasAttribute?.('data-tweak')) continue;
      let rules;
      try { rules = sheet.cssRules; } catch { unreadable++; continue; } // cross-origin sheet: counted and reported in the panel
      visit(rules);
    }
    const computed = getComputedStyle(root);
    return {
      vars: names
        .map((name) => ({ name, initial: computed.getPropertyValue(name).trim() }))
        .filter((v) => v.initial)
        .map((v) => ({ ...v, kind: classify(v.initial), derived: derived.has(v.name) })),
      unreadable,
    };
  }

  // Measured, not guessed: a design system declares many tokens a given page never uses, and some tokens
  // copy a value instead of referencing another one, so changing them repaints nothing.
  const MEASURED = ['color', 'background-color', 'background-image', 'border-top-color', 'border-right-color',
    'border-bottom-color', 'border-left-color', 'border-top-width', 'border-left-width', 'border-top-left-radius',
    'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius', 'outline-color', 'fill',
    'stroke', 'text-decoration-color', 'box-shadow', 'font-size', 'font-weight', 'font-family', 'line-height',
    'letter-spacing', 'margin-top', 'margin-bottom', 'margin-left', 'padding-top', 'padding-bottom', 'padding-left',
    'padding-right', 'row-gap', 'column-gap', 'grid-template-columns', 'width', 'max-width', 'opacity'];
  const SPACING_PROPS = ['margin-top', 'margin-bottom', 'margin-left', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'row-gap', 'column-gap'];
  const RADIUS_PROPS = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius'];

  function probeValue(v) {
    if (v.kind === 'color') return rgba(v.initial).join(',') === '255,0,255,1' ? '#00ff01' : '#ff00ff';
    if (v.kind === 'length') {
      const [, num, unit] = v.initial.match(LENGTH_RE);
      return `${Number(num) * 1.5 + 7}${unit}`;
    }
    if (v.kind === 'number') {
      const n = Number(v.initial);
      if (Number.isInteger(n) && n >= 100 && n <= 900 && n % 100 === 0) return n >= 500 ? '100' : '900';
      return String(n * 1.5 + 1);
    }
    return 'initial'; // makes every var() use of it invalid, which changes whatever relies on it
  }

  async function measureEffects(list) {
    const nodes = [root, document.body, ...document.body.querySelectorAll('*')].filter((n) => n !== host && !host.contains(n));
    const snap = () => nodes.map((n) => {
      const cs = getComputedStyle(n);
      return MEASURED.map((p) => cs.getPropertyValue(p));
    });
    const base = snap();
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      root.style.setProperty(v.name, probeValue(v));
      const after = snap();
      root.style.removeProperty(v.name);
      const props = new Set();
      let count = 0;
      after.forEach((values, j) => {
        let changed = false;
        values.forEach((value, k) => { if (value !== base[j][k]) { changed = true; props.add(MEASURED[k]); } });
        if (changed) count++;
      });
      v.effect = count;
      v.props = props;
      if (i % MEASURE_BATCH === MEASURE_BATCH - 1) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  // Variables referenced anywhere in the CSS, print rules included: one used only in @media print has no
  // effect on screen but still shapes the PDF, so it must not be filed as unused.
  function referencedVariables() {
    const direct = new Set();
    const graph = new Map();
    const VAR_RE = /var\(\s*(--[\w-]+)/g;
    const DECL_RE = /(--?[\w-]+)\s*:\s*([^;]*)/g;
    const read = (cssText) => {
      for (const [, prop, value] of cssText.matchAll(DECL_RE)) {
        const refs = [...value.matchAll(VAR_RE)].map((m) => m[1]);
        if (!refs.length) continue;
        if (prop.startsWith('--')) graph.set(prop, new Set([...(graph.get(prop) ?? []), ...refs]));
        else refs.forEach((r) => direct.add(r));
      }
    };
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.style) read(rule.style.cssText);
        if (rule.cssRules) visit(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode?.hasAttribute?.('data-tweak')) continue;
      try { visit(sheet.cssRules); } catch { continue; } // unreadable sheets are already counted by collectRootVars
    }
    for (const node of document.querySelectorAll('[style]')) read(node.getAttribute('style'));
    const used = new Set(direct);
    const queue = [...direct];
    while (queue.length) for (const next of graph.get(queue.pop()) ?? []) if (!used.has(next)) { used.add(next); queue.push(next); }
    return used;
  }

  // Colour role from the variable name, with the measurement to settle ambiguous names such as "muted".
  function guessRole(v) {
    // A colour computed from another one (a color-mix of the primary) follows its base: giving it a role would freeze it.
    if (v.derived) return null;
    const n = v.name.toLowerCase().replace(/^--/, '');
    if (/(^|-)(text|fg|ink|foreground)-[2-4]$/.test(n)) return 'textMuted'; // text tiers (text-2, text-3), not a scale
    if (/-\d{1,3}$/.test(n) || /(^|-)(white|black)$/.test(n)) return null; // scale steps are primitives, not roles
    if (/(hover|pressed|active|focus|disabled|visited|selected)/.test(n)) return null; // states keep their own value
    const status = n.match(/(success|positive|valid|warning|attention|caution|error|danger|destructive|negative)/);
    if (status) {
      if (/(surface|bg|background|subtle|soft|tint|container|50)/.test(n)) return null;
      if (/success|positive|valid/.test(status[1])) return 'success';
      return /warning|attention|caution/.test(status[1]) ? 'warning' : 'error';
    }
    if (/primary/.test(n) && /on-?dark/.test(n)) return null;
    if (/on-?(primary|accent|brand)/.test(n)) return 'onPrimary';
    if (/(on-?(strong|dark|emphasis|inverse)|inverse)/.test(n)) return 'onStrong';
    // A pale variant of the brand hue (accent-soft) is a tinted fill, not the hue: the hue would paint the block solid.
    if (/(primary|brand|accent|highlight)/.test(n) && /(soft|subtle|tint|weak|light|wash|bg|surface|container)$/.test(n)) return 'surfaceTint';
    if (/(border|line|rule|divider|outline|stroke|separator)/.test(n)) {
      return /(strong|functional|emphasis|accent|primary|brand|note|callout|frame)/.test(n) ? 'borderStrong' : 'border';
    }
    // A block background named after a hue or a block type is a tint, not the hue itself: surface-accent is a pale fill.
    if (/(surface|bg|background|fill|container)/.test(n) && /(accent|brand|primary|tint|quote|code|info|highlight|callout|selected)/.test(n)) return 'surfaceTint';
    const mutedish = /(muted|secondary|subtle|soft|light|tertiary|caption|meta)/.test(n);
    if (/(text|fg|foreground|(^|-)ink|copy|body-color|heading-color)/.test(n)) return mutedish ? 'textMuted' : 'text';
    if (/(primary|brand|link)/.test(n)) return 'primary';
    if (/(accent|highlight)/.test(n)) return 'accent';
    if (/(emphasis|strong|dark|band|contrast)/.test(n)) return 'surfaceStrong';
    if (/(paper|page|canvas|background|bg)$/.test(n) || /(^|-)(surface|base)$/.test(n)) return 'background';
    if (/(surface|card|panel|layer|sunken|well|container)/.test(n) || mutedish) {
      return v.props?.has('color') && !v.props.has('background-color') ? 'textMuted' : 'surface';
    }
    return null;
  }

  // Mappings are remembered per design system: variables sharing a prefix (--bs-, --md-sys-…) belong together.
  function mappingKey(colorVars) {
    const counts = new Map();
    for (const v of colorVars) {
      const prefix = v.name.match(/^--([a-z0-9]+)-/i)?.[1];
      if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    const [best, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
    return best && count >= colorVars.length * 0.6 ? `prefixe:--${best}-` : `document:${docName}`;
  }

  // ---------- state ----------
  let vars = [];
  const varsByName = new Map();
  let mapping = new Map(); // variable name -> role id
  let mappingKeyValue = '';
  let mappingDirty = false;
  const cats = { fontSize: [], line: [], spacing: [], radius: [], measure: [], fonts: { heading: null, body: null, code: null } };
  let displayClasses = [];
  let baseSize = null; // the font-size variable used by most elements: the body text
  const data = { integrees: [], mes: [], polices: { systeme: { piles: [] }, google: { familles: [] } }, regles: {} };
  const DEFAULT_GLOBALS = { text: 1, scale: 1, line: 1, density: 1, radius: 1, measure: 1 };
  const DEFAULT_TEXT = { align: null, hyphens: false, pretty: false };
  const state = {
    explicit: new Map(),
    globals: { ...DEFAULT_GLOBALS },
    fonts: { heading: null, body: null, code: null },
    text: { ...DEFAULT_TEXT },
    hidden: new Map(),
    palette: { id: 'document', nom: 'Ce document', source: 'document', dirty: false },
  };
  let applied = new Set();
  let showingOriginal = false;

  function parseLength(value) {
    const m = value.match(LENGTH_RE);
    return m ? { num: Number(m[1]), unit: m[2] } : null;
  }
  function fmtLength(num, unit) {
    const rounded = unit.toLowerCase() === 'px' ? Math.round(num * 2) / 2 : Number(num.toFixed(3));
    return `${rounded}${unit}`;
  }

  // Final value of every variable the panel drives: globals first, then fonts, then explicit edits win.
  function computeTarget() {
    const out = new Map();
    const g = state.globals;
    if (baseSize && (g.text !== 1 || g.scale !== 1)) {
      const base = parseLength(baseSize.initial);
      for (const v of cats.fontSize) {
        const s = parseLength(v.initial);
        if (!s || s.num <= 0) continue;
        const sameUnit = s.unit === base.unit && base.num > 0;
        const value = sameUnit ? base.num * g.text * (s.num / base.num) ** g.scale : s.num * g.text;
        out.set(v.name, fmtLength(value, s.unit));
      }
    }
    if (g.line !== 1) for (const v of cats.line) out.set(v.name, String(Number((Number(v.initial) * g.line).toFixed(3))));
    if (g.density !== 1) for (const v of cats.spacing) { const s = parseLength(v.initial); if (s) out.set(v.name, fmtLength(s.num * g.density, s.unit)); }
    if (g.radius !== 1) for (const v of cats.radius) { const s = parseLength(v.initial); if (s) out.set(v.name, fmtLength(s.num * g.radius, s.unit)); }
    if (g.measure !== 1) for (const v of cats.measure) { const s = parseLength(v.initial); if (s) out.set(v.name, fmtLength(s.num * g.measure, s.unit)); }
    if (state.text.align) out.set(ALIGN_VAR, state.text.align);
    if (state.text.hyphens) out.set(HYPHENS_VAR, 'auto');
    if (state.text.pretty) out.set(WRAP_VAR, 'pretty');
    // Both the document's variable and the body rule: the rule also carries the font into form controls.
    if (state.fonts.body) { out.set(FONT_VAR_BODY, state.fonts.body.stack); if (cats.fonts.body) out.set(cats.fonts.body.name, state.fonts.body.stack); }
    // The rule too, for kbd and samp left to the browser's monospace.
    if (state.fonts.code) { out.set(FONT_VAR_CODE, state.fonts.code.stack); if (cats.fonts.code) out.set(cats.fonts.code.name, state.fonts.code.stack); }
    if (state.fonts.heading) {
      out.set(FONT_VAR_HEADING, state.fonts.heading.stack);
      if (cats.fonts.heading) out.set(cats.fonts.heading.name, state.fonts.heading.stack);
      if (displayClasses.length) out.set(HEADING_EXTRA_VAR, displayClasses.join(' '));
    }
    for (const [name, value] of state.explicit) out.set(name, value);
    return out;
  }

  const currentValue = (name) => computeTarget().get(name) ?? varsByName.get(name)?.initial ?? '';

  function render() {
    const target = computeTarget();
    for (const name of applied) if (!target.has(name)) root.style.removeProperty(name);
    for (const [name, value] of target) {
      if (varsByName.get(name)?.initial === value) root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    }
    applied = new Set(target.keys());
    const extra = (target.get(HEADING_EXTRA_VAR) ?? '').split(' ').filter(Boolean).map((c) => `, .${CSS.escape(c)}`).join('');
    fixedRuleStyle.textContent = Object.entries(data.regles).filter(([name]) => target.has(name)).map(([, rule]) => rule.replace('{extra}', extra)).join('\n');
    for (const f of Object.values(state.fonts)) if (f?.google) loadGooglePreview(f.google);
    scheduleContrast();
    requestAnimationFrame(syncMeasureReport);
  }

  function loadGooglePreview(family) {
    if (document.querySelector(`link[data-tweak-font="${CSS.escape(family)}"]`)) return;
    const entry = data.polices.google.familles.find((f) => f.famille === family);
    const axes = entry?.italique ? 'ital,wght@0,400;0,600;0,700;1,400' : 'wght@400;600;700';
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${axes}&display=swap`;
    link.setAttribute('data-tweak', '');
    link.setAttribute('data-tweak-font', family);
    link.addEventListener('error', () => setStatus(`Aperçu de ${family} indisponible : pas de connexion à Google Fonts.`, true));
    document.head.appendChild(link);
  }

  // ---------- history ----------
  const history = { past: [], future: [] };
  let committed = '';
  const snapshot = () => JSON.stringify({
    explicit: [...state.explicit], globals: state.globals, fonts: state.fonts, text: state.text,
    hidden: [...state.hidden.keys()], palette: state.palette,
  });
  function commit() {
    const now = snapshot();
    if (now === committed) return;
    history.past.push(committed);
    history.future = [];
    committed = now;
    syncHeader();
  }
  function restore(serialized) {
    const s = JSON.parse(serialized);
    state.explicit = new Map(s.explicit);
    state.globals = { ...s.globals };
    state.fonts = { ...s.fonts };
    state.text = { ...s.text };
    state.palette = { ...s.palette };
    for (const item of state.hidden.values()) item.node.removeAttribute('data-tweak-hidden');
    state.hidden.clear();
    for (const id of s.hidden) {
      const node = document.querySelector(`[data-tweak-id="${id}"]`);
      if (node) { node.setAttribute('data-tweak-hidden', ''); state.hidden.set(id, { node, label: describe(node) }); }
    }
    render();
    syncAll();
  }
  function undo() {
    if (!history.past.length) return;
    history.future.push(committed);
    committed = history.past.pop();
    restore(committed);
  }
  function redo() {
    if (!history.future.length) return;
    history.past.push(committed);
    committed = history.future.pop();
    restore(committed);
  }

  // ---------- panel ----------
  const host = document.createElement('div');
  host.setAttribute('data-tweak-host', '');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
<style>
:host{all:initial}
*{box-sizing:border-box}
.panel{--bg:#fff;--subtle:#f5f6f8;--line:#e3e6eb;--ink:#1c2230;--muted:#5d6676;--accent:#2f5bd3;--accent-soft:#e8eefc;--warn:#b42318;--ok:#1a7f37;
  position:fixed;top:12px;right:12px;bottom:12px;width:${PANEL_WIDTH}px;z-index:2147483647;display:flex;flex-direction:column;
  background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 40px rgba(16,24,40,.16);
  font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light;overflow:hidden}
.panel.collapsed{bottom:auto;width:auto}
.panel.collapsed .tabs,.panel.collapsed .body,.panel.collapsed .foot,.panel.collapsed .chip{display:none}
.top{display:flex;align-items:center;gap:6px;padding:10px 10px 8px 14px}
.brand{font-weight:700;font-size:14px;letter-spacing:-.01em}
.chip{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--muted)}
.chip b{color:var(--ink);font-weight:600}
.badge{font-size:11px;padding:1px 7px;border-radius:999px;background:${mode === 'explore' ? '#fff4e5' : 'var(--accent-soft)'};color:${mode === 'explore' ? '#8a4b00' : 'var(--accent)'};white-space:nowrap}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer;border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:5px 10px}
button:hover{background:var(--subtle)}
button:disabled{opacity:.45;cursor:default}
button:focus-visible,input:focus-visible,select:focus-visible,[role=tab]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.icon{width:30px;height:30px;padding:0;display:inline-grid;place-items:center;font-size:15px}
.hold[aria-pressed=true]{background:var(--ink);color:#fff;border-color:var(--ink)}
.tabs{display:flex;gap:2px;margin:0 10px;padding:3px;background:var(--subtle);border-radius:10px}
[role=tab]{flex:1;border:0;background:none;border-radius:7px;padding:6px 4px;font-weight:600;color:var(--muted)}
[role=tab][aria-selected=true]{background:var(--bg);color:var(--ink);box-shadow:0 1px 2px rgba(16,24,40,.12)}
.body{flex:1;overflow:auto;padding:4px 14px 14px}
[role=tabpanel][hidden]{display:none}
h3{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:16px 0 8px;display:flex;align-items:center;gap:6px}
h3 .count{font-weight:500;letter-spacing:0;text-transform:none}
h4{font-size:12px;font-weight:600;color:var(--muted);margin:10px 0 6px}
.gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.pcard{display:flex;flex-direction:column;gap:4px;padding:4px;border-radius:9px;text-align:left;border:1px solid var(--line);background:var(--bg);min-width:0}
.pcard[aria-pressed=true]{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.pv{position:relative;display:block;height:46px;border-radius:5px;overflow:hidden;border:1px solid rgba(0,0,0,.06)}
.pv-head{position:absolute;left:6px;top:4px;font-size:16px;font-weight:700;line-height:1}
.pv-bar{position:absolute;left:6px;top:23px;width:26px;height:4px;border-radius:2px}
.pv-surface{position:absolute;right:5px;top:4px;width:30px;height:13px;border-radius:3px;border:1px solid}
.pv-surface i{position:absolute;left:4px;right:4px;top:4px;height:3px;border-radius:2px}
.pv-tint{position:absolute;right:5px;top:20px;width:30px;height:11px;border-radius:2px;border-left:3px solid}
.pv-strong{position:absolute;left:0;right:0;bottom:0;height:11px;display:flex;gap:3px;align-items:center;padding:0 6px}
.pv-strong i{width:6px;height:6px;border-radius:50%}
.pname{display:flex;gap:3px;align-items:center;font-size:11px;font-weight:600;padding:0 2px;line-height:1.25}
.pname>span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.warnmark{color:#b54708;font-size:12px}
.pfonts{font-size:10px;color:var(--muted);padding:0 2px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stylemark{color:var(--muted);font-size:11px}
#p-style>.seg{margin-bottom:8px}
.roles{display:grid;gap:2px}
.role{display:grid;grid-template-columns:30px 1fr 84px auto;align-items:center;gap:8px;padding:4px 0}
.swatch{position:relative;width:30px;height:30px;border-radius:8px;border:1px solid rgba(0,0,0,.12);overflow:hidden}
.swatch input{position:absolute;inset:-6px;width:42px;height:42px;opacity:0;cursor:pointer}
.role label{font-weight:600}
.role .vars{display:block;font-weight:400;font-size:11px;color:var(--muted)}
.role input[type=text]{width:84px;font:12px ui-monospace,Consolas,monospace;padding:4px 6px;border:1px solid var(--line);border-radius:6px}
.cr{font-size:11px;padding:1px 6px;border-radius:999px;white-space:nowrap}
.cr.ok{background:#e7f5ec;color:var(--ok)}
.cr.ko{background:#fdecea;color:var(--warn)}
.row-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.saveform{display:flex;gap:6px;margin-top:8px}
.saveform input{flex:1;min-width:0;padding:5px 8px;border:1px solid var(--line);border-radius:8px}
.field{display:grid;gap:4px;margin:8px 0}
.field .lab{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.field .lab span{font-weight:600}
.field .lab output{font-size:12px;color:var(--muted)}
.field .ends{display:flex;justify-content:space-between;font-size:11px;color:var(--muted)}
.field .line{display:flex;align-items:center;gap:6px}
.field input[type=range]{flex:1;accent-color:var(--accent)}
.mini{border:0;background:none;padding:0 4px;color:var(--muted);visibility:hidden}
.field.changed .mini{visibility:visible}
select{width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
.seg{display:flex;gap:2px;padding:2px;background:var(--subtle);border-radius:8px}
.seg button{flex:1;border:0;background:none;padding:4px}
.seg button[aria-pressed=true]{background:var(--bg);box-shadow:0 1px 2px rgba(16,24,40,.12);font-weight:600}
.hint{margin:6px 0 0;color:var(--muted);font-size:12px}
.hint.warn{color:var(--warn)}
.check{display:flex;align-items:center;gap:6px;margin:6px 0}
.hint.warn{color:var(--warn)}
.hint.ok{color:var(--ok)}
.empty{color:var(--muted);font-style:italic}
ul{list-style:none;margin:6px 0 0;padding:0}
li{display:flex;gap:6px;align-items:center;padding:3px 0}
li span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
li button{padding:1px 8px;font-size:12px}
.issue{cursor:pointer}
.dot{width:16px;height:16px;border-radius:4px;border:1px solid rgba(0,0,0,.12);flex:none}
details{border-top:1px solid var(--line);padding:6px 0}
summary{cursor:pointer;font-weight:600;padding:2px 0}
summary .count{font-weight:400;color:var(--muted)}
details.idle{border-top:none;margin-top:4px;padding:4px 0 0}
details.idle summary{font-weight:400;color:var(--muted)}
.tools{display:flex;gap:8px;align-items:center;margin:10px 0 4px}
.tools input[type=search]{flex:1;min-width:0;padding:5px 8px;border:1px solid var(--line);border-radius:8px}
.vrow{padding:6px 0;border-bottom:1px dashed var(--line)}
.vrow[hidden]{display:none}
.vrow.changed code{color:#c4320a}
.vhead{display:flex;align-items:center;gap:6px}
.vhead code{flex:1;font:11.5px/1.3 ui-monospace,Consolas,monospace;word-break:break-all}
.uses{font-size:11px;color:var(--muted);white-space:nowrap}
.vctl{display:flex;align-items:center;gap:6px;margin-top:4px}
.vctl input[type=range]{flex:1;min-width:0;accent-color:var(--accent)}
.vctl input[type=number]{width:72px;padding:3px 5px;border:1px solid var(--line);border-radius:6px}
.vctl input[type=text]{flex:1;min-width:0;padding:3px 6px;border:1px solid var(--line);border-radius:6px;font:12px ui-monospace,Consolas,monospace}
.vctl input[type=color]{width:30px;height:26px;padding:0;border:1px solid var(--line);border-radius:6px;background:none}
.vctl select{width:auto;flex:1;padding:3px 6px}
.unit{color:var(--muted);font-size:12px;min-width:22px}
input.invalid{border-color:var(--warn)!important}
.foot{border-top:1px solid var(--line);padding:10px 14px;display:grid;grid-template-columns:1fr 1.4fr;gap:6px}
.foot .primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.foot .primary:hover{background:#2649b0}
.foot .confirm{background:#d9480f;border-color:#d9480f;color:#fff}
.foot .quit{grid-column:1/-1;border:0;background:none;color:var(--muted);font-size:12px;padding:2px}
.foot .quit.confirm{color:#fff}
.status{grid-column:1/-1;margin:0;font-size:12px;color:var(--muted);min-height:16px;word-break:break-word}
.status.error{color:var(--warn)}
</style>
<div class="panel" role="complementary" aria-label="Panneau tweak">
  <div class="top">
    <span class="brand">Tweak</span><span class="badge">${mode === 'explore' ? 'Exploration' : 'Normal'}</span>
    <span class="chip" id="chip"></span>
    <button class="icon" id="undo" title="Annuler (Ctrl+Z)" aria-label="Annuler">↶</button>
    <button class="icon" id="redo" title="Rétablir (Ctrl+Maj+Z)" aria-label="Rétablir">↷</button>
    <button class="icon hold" id="original" title="Maintenir pour voir l'original" aria-label="Maintenir pour voir l'original" aria-pressed="false">◐</button>
    <button class="icon" id="collapse" title="Replier le panneau" aria-label="Replier le panneau" aria-expanded="true">–</button>
  </div>
  <div class="tabs" role="tablist" aria-label="Sections du panneau">
    <button role="tab" id="t-style" aria-controls="p-style" aria-selected="true">Style</button>
    <button role="tab" id="t-sections" aria-controls="p-sections" aria-selected="false" tabindex="-1">Sections</button>
    <button role="tab" id="t-check" aria-controls="p-check" aria-selected="false" tabindex="-1">Contrôle</button>
    <button role="tab" id="t-advanced" aria-controls="p-advanced" aria-selected="false" tabindex="-1">Avancé</button>
  </div>
  <div class="body">
    <section role="tabpanel" id="p-style" aria-labelledby="t-style">
      <h3>Palettes</h3>
      <div class="seg" role="group" aria-label="Ce qu'applique une palette"><button type="button" id="scope-colors" aria-pressed="false">Couleurs</button><button type="button" id="scope-style" aria-pressed="true" title="Couleurs, polices, arrondi des blocs et interligne des palettes marquées ✦">Style complet</button></div>
      <div id="gallery"></div>
      <h3>Couleurs <span class="count" id="roles-count"></span></h3>
      <div class="roles" id="roles"></div>
      <p class="hint" id="roles-hint"></p>
      <div class="row-actions" id="palette-actions"></div>
      <h3>Typographie</h3>
      <div class="field"><div class="lab"><span>Police des titres</span></div><select id="font-heading" aria-label="Police des titres"></select></div>
      <div class="field"><div class="lab"><span>Police du texte</span></div><select id="font-body" aria-label="Police du texte"></select></div>
      <div class="field"><div class="lab"><span>Police du code</span></div><select id="font-code" aria-label="Police du code"></select></div>
      <div id="typo-sliders"></div>
      <h3>Mise en page du texte</h3>
      <div class="field"><div class="lab"><span>Alignement</span></div>
        <div class="seg" role="group" aria-label="Alignement du texte"><button type="button" id="align-left" aria-pressed="true">Au fer à gauche</button><button type="button" id="align-justify" aria-pressed="false">Justifié</button></div></div>
      <label class="check"><input type="checkbox" id="hyphens"> Césure automatique</label>
      <label class="check"><input type="checkbox" id="pretty"> Lignes harmonisées</label>
      <p class="hint" id="text-hint"></p>
      <div id="measure-sliders"></div>
      <p class="hint" id="measure-report"></p>
      <div class="row-actions"><button type="button" id="balance">Équilibrer les marges</button></div>
      <h3>Espacement et formes</h3>
      <div id="shape-sliders"></div>
    </section>
    <section role="tabpanel" id="p-sections" aria-labelledby="t-sections" hidden>
      <h3>Masquer des sections</h3>
      <button id="pick">Choisir une section à masquer</button>
      <p class="hint" id="pick-hint" hidden>Survole la page puis clique pour masquer. Flèches haut et bas : élargir ou réduire la zone. Échap : terminer.</p>
      <p class="hint" id="pick-info"></p>
      <ul id="hidden-list"></ul>
    </section>
    <section role="tabpanel" id="p-check" aria-labelledby="t-check" hidden>
      <h3>Contraste du texte</h3>
      <p id="contrast-summary" class="hint"></p>
      <ul id="contrast-list"></ul>
    </section>
    <section role="tabpanel" id="p-advanced" aria-labelledby="t-advanced" hidden>
      <div class="tools"><input type="search" id="filter" placeholder="Filtrer les variables" aria-label="Filtrer les variables">
        <label><input type="checkbox" id="only-changed"> Modifiées</label></div>
      <div id="mapping-bar" class="row-actions"></div>
      <div id="groups"></div>
    </section>
  </div>
  <div class="foot">
    <button id="print">Aperçu impression</button>
    <button id="bake" class="primary">${mode === 'explore' ? 'Enregistrer la proposition' : 'Enregistrer dans le fichier'}</button>
    <button id="quit" class="quit">Quitter sans enregistrer</button>
    <p class="status" id="status" role="status"></p>
  </div>
</div>`;
  const $ = (id) => shadow.getElementById(id);

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, val] of Object.entries(attrs)) node.setAttribute(k, val);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function setStatus(text, isError = false) {
    $('status').textContent = text;
    $('status').classList.toggle('error', isError);
  }
  async function post(route, payload) {
    const response = await fetch(api(route), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}) });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || `Erreur ${response.status}`);
    return body;
  }
  // A second click within a few seconds confirms an action that writes, deletes or leaves.
  function armed(button, label, action) {
    let timer = null;
    const original = button.textContent;
    const originalClass = button.className;
    const reset = () => { clearTimeout(timer); timer = null; button.textContent = original; button.className = originalClass; };
    button.addEventListener('click', () => {
      if (timer) { reset(); return action(); }
      button.textContent = label();
      button.className = `${originalClass} confirm`;
      timer = setTimeout(reset, CONFIRM_WINDOW_MS);
    });
  }

  // ---------- tabs ----------
  const tabs = [...shadow.querySelectorAll('[role=tab]')];
  function selectTab(tab) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
    tab.focus();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') selectTab(tabs[(i + 1) % tabs.length]);
      else if (e.key === 'ArrowLeft') selectTab(tabs[(i - 1 + tabs.length) % tabs.length]);
      else return;
      e.preventDefault();
    });
  });

  // ---------- palettes ----------
  function rolesFromDocument() {
    const roles = {};
    for (const v of vars) {
      const role = mapping.get(v.name);
      if (role && !(role in roles)) roles[role] = v.initial;
    }
    return roles;
  }
  function currentRoles() {
    const roles = {};
    const target = computeTarget();
    for (const v of vars) {
      const role = mapping.get(v.name);
      if (role && !(role in roles)) roles[role] = target.get(v.name) ?? v.initial;
    }
    return roles;
  }
  const mappedVars = (role) => vars.filter((v) => mapping.get(v.name) === role);

  // Missing roles are derived from the palette's own colours, never left at the document's: a teal quote fill
  // and a teal frame kept under an indigo palette read as a coloured layer pasted over the page.
  // Status colours are the exception, since their meaning matters more than harmony.
  const mix = (a, b, t) => { const x = rgba(a), y = rgba(b); return hex([0, 1, 2].map((i) => Math.round(x[i] * t + y[i] * (1 - t)))); };
  function completePalette(roles) {
    const r = { ...roles };
    if (!r.background || !r.text) return r;
    r.primary ??= r.text;
    r.accent ??= r.primary;
    r.textMuted ??= mix(r.text, r.background, 0.68);
    r.surface ??= mix(r.text, r.background, 0.045);
    r.surfaceTint ??= mix(r.primary, r.background, 0.1);
    r.border ??= mix(r.text, r.background, 0.14);
    r.borderStrong ??= r.primary;
    r.surfaceStrong ??= r.text;
    liftForLegibility(r, rolesFromDocument());
    r.onStrong ??= contrastOf(r.background, r.surfaceStrong) >= contrastOf(r.text, r.surfaceStrong) ? r.background : r.text;
    r.onPrimary ??= contrastOf(r.background, r.primary) >= contrastOf(r.text, r.primary) ? r.background : r.text;
    liftPrimaryFill(r);
    return r;
  }

  // Text colours stay legible on every fill of the palette: a status kept from a light document, or a muted text,
  // is mixed toward the palette's text until it reaches AA (4.5:1) on the page, the cards, the tints and the status
  // tints. Primary and accent keep more of their brand hue: AA only when the document sets text in them, 3:1 otherwise.
  // The small margin covers tints the document mixes itself, which never match the estimate exactly.
  const LEGIBLE = CONTRAST_NORMAL + 0.15;
  // Read from the style sheets, not only from the measure: a rule for a hidden tab sets text colour too.
  let textColorRefs = null;
  function cssTextColorRefs() {
    if (textColorRefs) return textColorRefs;
    textColorRefs = new Set();
    const visit = (rules) => { for (const rule of rules) {
      if (rule.style) for (const m of (rule.style.getPropertyValue('color') || '').matchAll(/var\((--[\w-]+)/g)) textColorRefs.add(m[1]);
      if (rule.cssRules) visit(rule.cssRules);
    } };
    for (const sheet of document.styleSheets) { if (sheet.ownerNode?.hasAttribute?.('data-tweak')) continue; try { visit(sheet.cssRules); } catch { /* cross-origin */ } }
    return textColorRefs;
  }
  const usedAsText = (role) => mappedVars(role).some((v) => v.props?.has('color') || cssTextColorRefs().has(v.name));
  function liftForLegibility(r, doc) {
    const base = r.surface ?? r.background;
    const fills = () => [r.background, r.surface, r.surfaceTint, ...['primary', 'accent', 'success', 'warning', 'error'].map((k) => r[k] && mix(r[k], base, 0.1))].filter(Boolean);
    const lift = (color, target) => {
      if (!color) return color;
      let c = color;
      for (let t = 0.1; t < 1.05 && Math.min(...fills().map((f) => contrastOf(c, f))) < target; t += 0.1) c = mix(r.text, color, Math.min(t, 1));
      return c;
    };
    for (const k of ['success', 'warning', 'error']) r[k] = lift(r[k] ?? doc[k], LEGIBLE);
    r.textMuted = lift(r.textMuted, LEGIBLE);
    r.primary = lift(r.primary, usedAsText('primary') ? LEGIBLE : CONTRAST_LARGE);
    r.accent = lift(r.accent, usedAsText('accent') ? LEGIBLE : CONTRAST_LARGE);
  }
  // Text set on a primary fill (a filled card, a pressed button) needs AA too: when neither the page colour nor the
  // text colour reaches it on a mid-tone primary, the primary is pushed away from the text that sits on it.
  function liftPrimaryFill(r) {
    if (!r.primary || !r.onPrimary || !mappedVars('onPrimary').length) return;
    const far = r.onPrimary === r.background ? r.text : r.background;
    const start = r.primary;
    for (let t = 0.05; t < 1.05 && contrastOf(r.onPrimary, r.primary) < LEGIBLE; t += 0.05) r.primary = mix(far, start, Math.min(t, 1));
  }

  function applyPalette(p, source) {
    const roles = source === 'document' ? p.roles : completePalette(p.roles);
    for (const v of vars) {
      const role = mapping.get(v.name);
      if (!role) continue;
      const value = source === 'document' ? null : role === 'onStrong' ? roles.onStrong ?? roles.background : roles[role];
      if (value) state.explicit.set(v.name, value);
      else state.explicit.delete(v.name);
    }
    state.palette = { id: p.id, nom: p.nom, source, dirty: false };
    const styleNote = paletteScope === 'style' ? applyStyle(source === 'document' ? null : p.style) : '';
    render();
    syncAll();
    commit();
    const note = p.notes ? ` ${p.notes}` : '';
    setStatus(`Palette « ${p.nom} » appliquée.${styleNote}${note}`);
  }

  // Full style: the brand's fonts (headings, text, code), block radius and body line height, expressed through the panel's own controls so
  // undo, sliders and bake treat them like a hand setting. Null resets them to the document's.
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const strongest = (list) => [...list].sort((a, b) => b.effect - a.effect)[0];
  function fontByFamily(name) {
    if (!name) return null;
    if (data.polices.google.familles.some((f) => f.famille === name)) return fontFromOption(`g:${name}`);
    const i = data.polices.systeme.piles.findIndex((p) => p.nom === name);
    return i >= 0 ? fontFromOption(`sys:${i}`) : null;
  }
  function applyStyle(s) {
    state.fonts = { heading: fontByFamily(s?.titres), body: fontByFamily(s?.texte), code: fontByFamily(s?.code) };
    state.globals.radius = 1;
    state.globals.line = 1;
    if (!s) return ' Polices, arrondi et interligne du document rétablis.';
    const done = [];
    const families = [s.titres, s.texte, s.code].filter((x, i, a) => x && a.indexOf(x) === i);
    if (families.length) done.push(`polices ${families.join(', ')}`);
    const radii = cats.radius.filter((v) => { const l = parseLength(v.initial); return l && l.num > 0 && l.num < 100; });
    const target = parseLength(s.arrondi ?? '');
    if (target && radii.length) {
      // The brand radius is the cards' one: the largest radius, not the most used (buttons often outnumber blocks).
      const base = Math.max(...radii.map((v) => parseLength(v.initial).num));
      // Unclamped, so a brand radius lands exactly whatever radius the document had before (16 px stays 16 px).
      state.globals.radius = Math.round((target.num / base) * 100) / 100;
      done.push(`arrondi ${s.arrondi}`);
    }
    if (s.interligne && cats.line.length) {
      state.globals.line = Math.round(clamp(s.interligne / Number(strongest(cats.line).initial), 0.85, 1.25) * 100) / 100;
      done.push(`interligne ${fr(s.interligne, 2)}`);
    }
    return done.length ? ` Style : ${done.join(', ')}.` : ' Cette palette ne porte que des couleurs.';
  }
  let paletteScope = 'style'; // the usual intent is a whole new look; colours alone stay one click away
  for (const [id, scope] of [['scope-colors', 'colors'], ['scope-style', 'style']]) {
    $(id).addEventListener('click', () => {
      paletteScope = scope;
      $('scope-colors').setAttribute('aria-pressed', String(scope === 'colors'));
      $('scope-style').setAttribute('aria-pressed', String(scope === 'style'));
      renderGallery();
      setStatus(scope === 'style' ? 'Un clic sur une palette ✦ applique aussi ses polices, son arrondi et son interligne.' : 'Un clic sur une palette n\'applique que ses couleurs.');
    });
  }

  function paletteWarning(p) {
    const r = p.roles;
    const issues = [];
    if (r.text && r.background && contrastOf(r.text, r.background) < CONTRAST_NORMAL) issues.push('texte');
    if (r.primary && r.background && contrastOf(r.primary, r.background) < CONTRAST_NORMAL) issues.push('primaire');
    if (p.lisibilite && p.lisibilite !== 'ok') issues.push('accents');
    return issues;
  }

  function paletteCard(p, source) {
    const r = { ...rolesFromDocument(), ...(source === 'document' ? p.roles : completePalette(p.roles)) };
    const card = el('button', { class: 'pcard', type: 'button', 'aria-pressed': String(state.palette.id === p.id && state.palette.source === source) });
    const pv = el('span', { class: 'pv', 'aria-hidden': 'true' });
    pv.style.background = r.background ?? '#fff';
    const head = el('span', { class: 'pv-head' }, 'Aa');
    head.style.color = r.text ?? '#111';
    if (state.fonts.heading) head.style.fontFamily = state.fonts.heading.stack;
    const bar = el('span', { class: 'pv-bar' });
    bar.style.background = r.primary ?? '#333';
    const surf = el('span', { class: 'pv-surface' });
    surf.style.background = r.surface ?? '#f4f4f4';
    surf.style.borderColor = r.border ?? '#ddd';
    const line = el('i');
    line.style.background = r.textMuted ?? '#888';
    surf.append(line);
    const tint = el('span', { class: 'pv-tint' });
    tint.style.background = r.surfaceTint ?? r.surface ?? '#eef';
    tint.style.borderLeftColor = r.borderStrong ?? r.primary ?? '#333';
    const strong = el('span', { class: 'pv-strong' });
    strong.style.background = r.surfaceStrong ?? '#222';
    for (const role of ['accent', 'success', 'warning', 'error']) {
      const dot = el('i');
      dot.style.background = r[role] ?? 'transparent';
      strong.append(dot);
    }
    pv.append(head, bar, surf, tint, strong);
    const name = el('span', { class: 'pname' });
    name.append(el('span', {}, p.nom));
    const warn = paletteWarning({ ...p, roles: r });
    if (p.style) name.append(el('span', { class: 'stylemark', title: `Style complet : ${[p.style.titres, p.style.texte].filter(Boolean).join(' / ')}${p.style.arrondi ? `, arrondi ${p.style.arrondi}` : ''}` }, '✦'));
    if (warn.length) name.append(el('span', { class: 'warnmark', title: `Contraste insuffisant : ${warn.join(', ')}. ${p.notes ?? ''}`.trim() }, '⚠'));
    card.title = [p.nom, p.caractere, p.licence ? `Licence ${p.licence}` : ''].filter(Boolean).join(' · ');
    card.setAttribute('aria-label', `Appliquer la palette ${p.nom}`);
    card.append(pv, name);
    // Several brands share Inter: the fonts under the name tell which clicks will really change the type.
    if (p.style && paletteScope === 'style') card.append(el('span', { class: 'pfonts', title: fontLine(p.style) }, fontLine(p.style)));
    card.addEventListener('click', () => applyPalette(p, source));
    return card;
  }

  const fontLine = (s) => [s.titres === s.texte ? s.titres : `${s.titres} / ${s.texte}`, s.code].filter(Boolean).join(' · ');
  const isDark = (p) => !!p.roles.background && luminance(rgba(p.roles.background)) < 0.2;

  function renderGallery() {
    const box = $('gallery');
    box.replaceChildren();
    const groups = [
      ['Ce document', [{ id: 'document', nom: 'Original', roles: rolesFromDocument(), caractere: 'Les couleurs d\'origine du document' }], 'document'],
      ['Mes palettes', data.mes, 'mes'],
      ['Intégrées · claires', data.integrees.filter((p) => !isDark(p)), 'integree'],
      ['Intégrées · sombres', data.integrees.filter(isDark), 'integree'],
    ];
    for (const [title, list, source] of groups) {
      if (!list.length) continue;
      box.append(el('h4', {}, title));
      const grid = el('div', { class: 'gallery' });
      for (const p of list) grid.append(paletteCard(p, source));
      box.append(grid);
    }
  }

  function renderRoles() {
    const box = $('roles');
    box.replaceChildren();
    const roles = currentRoles();
    const present = ROLES.filter((r) => mappedVars(r.id).length);
    $('roles-count').textContent = present.length ? `${present.length} rôles` : '';
    for (const r of present) {
      const value = roles[r.id];
      const row = el('div', { class: 'role' });
      const sw = el('span', { class: 'swatch' });
      sw.style.background = value;
      const picker = el('input', { type: 'color', 'aria-label': `${r.label}, nuancier` });
      picker.value = hex(rgba(value));
      sw.append(picker);
      const names = mappedVars(r.id).map((v) => v.name);
      const label = el('label', {}, r.label);
      label.append(el('span', { class: 'vars', title: names.join(', ') }, names.length === 1 ? names[0] : `${names.length} variables`));
      const field = el('input', { type: 'text', 'aria-label': `${r.label}, valeur` });
      field.value = value;
      const badge = el('span');
      if (r.against && roles[r.against]) {
        const c = contrastOf(value, roles[r.against]);
        badge.className = `cr ${c >= CONTRAST_NORMAL ? 'ok' : 'ko'}`;
        badge.textContent = `${fr(c)} ${c >= CONTRAST_NORMAL ? 'AA' : '✗'}`;
        badge.title = `Contraste sur ${ROLE_BY_ID.get(r.against).label.toLowerCase()} : ${fr(c, 2)}:1 (seuil AA ${fr(CONTRAST_NORMAL)})`;
      }
      const setRole = (val, final) => {
        for (const v of mappedVars(r.id)) state.explicit.set(v.name, val);
        state.palette = { ...state.palette, dirty: true };
        sw.style.background = val;
        render();
        if (final) { syncAll(); commit(); }
      };
      picker.addEventListener('input', () => { field.value = picker.value; setRole(picker.value, false); });
      picker.addEventListener('change', () => setRole(picker.value, true));
      field.addEventListener('change', () => {
        const val = field.value.trim();
        const ok = isColor(val);
        field.classList.toggle('invalid', !ok);
        if (!ok) return setStatus(`Couleur non reconnue pour ${r.label}.`, true);
        setRole(val, true);
      });
      row.append(sw, label, field, badge);
      box.append(row);
    }
    const missing = ROLES.filter((r) => !r.id.startsWith('on') && !mappedVars(r.id).length);
    $('roles-hint').textContent = !present.length
      ? 'Aucune couleur du document n\'est rattachée à un rôle : rattache-les dans Avancé pour pouvoir appliquer des palettes.'
      : missing.length ? `Sans variable dans ce document : ${missing.map((r) => r.label.toLowerCase()).join(', ')}. Rattachement possible dans Avancé.` : '';
    renderPaletteActions();
  }

  function slug(text) {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'palette';
  }

  function renderPaletteActions() {
    const box = $('palette-actions');
    box.replaceChildren();
    const p = state.palette;
    const save = el('button', { type: 'button' }, 'Enregistrer comme nouvelle palette…');
    save.addEventListener('click', () => openSaveForm());
    box.append(save);
    if (p.source === 'mes') {
      const update = el('button', { type: 'button' }, `Mettre à jour « ${p.nom} »`);
      update.disabled = !p.dirty;
      update.addEventListener('click', () => persistPalette(p.id, p.nom));
      const remove = el('button', { type: 'button' }, 'Supprimer');
      armed(remove, () => `Confirmer la suppression de « ${p.nom} »`, async () => {
        try {
          const res = await post('palettes', { action: 'supprimer', palette: { id: p.id } });
          data.mes = res.palettes;
          state.palette = { id: 'personnalisee', nom: 'Palette personnalisée', source: 'personnalisee', dirty: true };
          syncAll();
          setStatus(`Palette « ${p.nom} » supprimée.`);
        } catch (error) { setStatus(error.message, true); }
      });
      box.append(update, remove);
    }
  }

  function openSaveForm() {
    const box = $('palette-actions');
    box.replaceChildren();
    const form = el('form', { class: 'saveform' });
    const input = el('input', { type: 'text', maxlength: '60', placeholder: 'Nom de la palette', 'aria-label': 'Nom de la palette' });
    const ok = el('button', { type: 'submit' }, 'Enregistrer');
    const cancel = el('button', { type: 'button' }, 'Annuler');
    cancel.addEventListener('click', renderPaletteActions);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name || /[<>]/.test(name)) return setStatus('Nom invalide : 1 à 60 caractères, sans < ni >.', true);
      let id = slug(name);
      const taken = new Set([...data.mes, ...data.integrees].map((x) => x.id));
      for (let n = 2; taken.has(id); n++) id = `${slug(name)}-${n}`;
      persistPalette(id, name);
    });
    form.append(input, ok, cancel);
    box.append(form);
    input.focus();
  }

  async function persistPalette(id, nom) {
    const roles = currentRoles();
    delete roles.onStrong;
    delete roles.onPrimary;
    try {
      const res = await post('palettes', { action: 'enregistrer', palette: { id, nom, roles } });
      data.mes = res.palettes;
      state.palette = { id, nom, source: 'mes', dirty: false };
      syncAll();
      commit();
      setStatus(`Palette « ${nom} » enregistrée : elle sera proposée dans toutes les sessions tweak.`);
    } catch (error) { setStatus(error.message, true); }
  }

  // ---------- typography and shape ----------
  function fontOptions(select, isHeading) {
    select.replaceChildren();
    select.append(el('option', { value: '' }, isHeading ? 'Comme le texte' : 'Police du document'));
    const groups = [
      ['Système, sans téléchargement', data.polices.systeme.piles.map((p, i) => [`sys:${i}`, p.nom])],
      ['Google Fonts, intégrée à l\'enregistrement', data.polices.google.familles.map((f) => [`g:${f.famille}`, f.famille])],
    ];
    for (const [label, options] of groups) {
      const group = el('optgroup', { label });
      for (const [value, text] of options) group.append(el('option', { value }, text));
      select.append(group);
    }
  }
  function fontFromOption(value) {
    if (!value) return null;
    if (value.startsWith('sys:')) {
      const p = data.polices.systeme.piles[Number(value.slice(4))];
      return { key: value, label: p.nom, stack: p.pile, google: null };
    }
    const f = data.polices.google.familles.find((x) => x.famille === value.slice(2));
    return { key: value, label: f.famille, stack: `'${f.famille}', ${f.repli}`, google: f.famille };
  }
  for (const [id, slot] of [['font-heading', 'heading'], ['font-body', 'body'], ['font-code', 'code']]) {
    $(id).addEventListener('change', () => {
      state.fonts[slot] = fontFromOption($(id).value);
      render();
      syncAll();
      commit();
    });
  }

  const SLIDERS = {
    text: { box: 'typo-sliders', label: 'Taille du texte', min: 0.8, max: 1.3, step: 0.01, ends: ['Plus petit', 'Plus grand'], cat: () => cats.fontSize,
      show: (k) => (baseSize ? `${fmtLength(parseLength(baseSize.initial).num * k, parseLength(baseSize.initial).unit)} · ${Math.round(k * 100)} %` : `${Math.round(k * 100)} %`) },
    scale: { box: 'typo-sliders', label: 'Hiérarchie des titres', min: 0.6, max: 1.5, step: 0.01, ends: ['Douce', 'Marquée'], cat: () => cats.fontSize, show: (k) => `${Math.round(k * 100)} %` },
    line: { box: 'typo-sliders', label: 'Interligne', min: 0.85, max: 1.25, step: 0.01, ends: ['Serré', 'Aéré'], cat: () => cats.line, show: (k) => `${Math.round(k * 100)} %` },
    density: { box: 'shape-sliders', label: 'Densité', min: 0.6, max: 1.6, step: 0.01, ends: ['Compact', 'Aéré'], cat: () => cats.spacing, show: (k) => `${Math.round(k * 100)} %`,
      presets: [['Compact', 0.8], ['Normal', 1], ['Aéré', 1.25]] },
    measure: { box: 'measure-sliders', label: 'Largeur du texte', min: 0.7, max: 1.5, step: 0.01, ends: ['Étroite', 'Large'], cat: () => cats.measure, show: (k) => `${Math.round(k * 100)} %` },
    radius: { box: 'shape-sliders', label: 'Arrondi des angles', min: 0, max: 6, step: 0.05, ends: ['Carré', 'Très arrondi'], cat: () => cats.radius, show: (k) => (k === 0 ? 'Carré' : `${Math.round(k * 100)} %`) },
  };
  const sliderUI = {};
  function buildSliders() {
    for (const [key, cfg] of Object.entries(SLIDERS)) {
      const field = el('div', { class: 'field' });
      const lab = el('div', { class: 'lab' });
      const out = el('output');
      lab.append(el('span', {}, cfg.label), out);
      const line = el('div', { class: 'line' });
      const range = el('input', { type: 'range', min: cfg.min, max: cfg.max, step: cfg.step, value: '1', 'aria-label': cfg.label });
      const reset = el('button', { class: 'mini', type: 'button', title: 'Valeur d\'origine', 'aria-label': `${cfg.label} : valeur d'origine` }, '↺');
      line.append(range, reset);
      const ends = el('div', { class: 'ends', 'aria-hidden': 'true' });
      ends.append(el('span', {}, cfg.ends[0]), el('span', {}, cfg.ends[1]));
      field.append(lab);
      let seg = null;
      if (cfg.presets) {
        seg = el('div', { class: 'seg', role: 'group', 'aria-label': `${cfg.label} : préréglages` });
        for (const [name, k] of cfg.presets) {
          const b = el('button', { type: 'button', 'aria-pressed': 'false' }, name);
          b.addEventListener('click', () => { state.globals[key] = k; render(); syncAll(); commit(); });
          seg.append(b);
        }
        field.append(seg);
      }
      field.append(line, ends);
      const count = cfg.cat().length;
      if (!count) {
        range.disabled = true;
        reset.disabled = true;
        seg?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        field.append(el('p', { class: 'hint' }, 'Aucune variable de ce type dans ce document.'));
      } else {
        range.title = `${count} variable(s) concernée(s)`;
      }
      range.addEventListener('input', () => { state.globals[key] = Number(range.value); render(); syncSliders(); });
      range.addEventListener('change', () => { syncAll(); commit(); });
      reset.addEventListener('click', () => { state.globals[key] = 1; render(); syncAll(); commit(); });
      $(cfg.box).append(field);
      sliderUI[key] = { field, range, out, seg, cfg };
    }
  }
  function syncSliders() {
    for (const [key, ui] of Object.entries(sliderUI)) {
      const k = state.globals[key];
      ui.range.value = String(k);
      ui.out.textContent = ui.cfg.show(k);
      ui.range.setAttribute('aria-valuetext', ui.cfg.show(k));
      ui.field.classList.toggle('changed', k !== 1);
      ui.seg?.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(ui.cfg.presets[i][1] === k)));
    }
  }

  // ---------- text layout ----------
  // The main text: the width shared by most long paragraphs held to a measure (a max-width), so a callout
  // or a quote, which usually spans its box, does not stand in for it.
  function mainTextSample() {
    const long = [...document.body.querySelectorAll('p, li')]
      .filter((n) => !host.contains(n) && n.offsetParent && n.textContent.trim().length > 150);
    const measured = long.filter((n) => getComputedStyle(n).maxWidth !== 'none');
    const blocks = measured.length ? measured : long;
    const byWidth = new Map();
    for (const n of blocks) { const w = Math.round(n.getBoundingClientRect().width); byWidth.set(w, [...(byWidth.get(w) ?? []), n]); }
    return [...byWidth.values()].sort((a, b) => b.length - a.length)[0]?.[0] ?? null;
  }
  // The visible page around the text: the nearest ancestor with its own background (a sheet), else the body.
  function pageOf(node) {
    for (let n = node.parentElement; n && n !== document.body; n = n.parentElement) {
      if (rgba(getComputedStyle(n).backgroundColor)[3] > 0) return n;
    }
    return document.body;
  }
  function lineCount(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.bottom))).size || 1;
  }
  let measureInfo = null;
  function syncMeasureReport() {
    const report = $('measure-report');
    const sample = mainTextSample();
    measureInfo = null;
    if (!sample) { report.textContent = 'Aucun paragraphe assez long pour mesurer la ligne.'; $('balance').disabled = true; return; }
    const box = sample.getBoundingClientRect();
    const page = pageOf(sample).getBoundingClientRect();
    const chars = Math.round(sample.textContent.replace(/\s+/g, ' ').trim().length / lineCount(sample));
    const left = Math.round(box.left - page.left);
    const right = Math.round(page.right - box.right);
    measureInfo = { width: box.width, left, right };
    const lopsided = Math.abs(right - left) > MARGIN_TOLERANCE * Math.max(left, right);
    const parts = [`Ligne d'environ ${chars} caractères.`, `Marges du texte : ${left} px à gauche, ${right} px à droite.`];
    if (chars > MEASURE_MAX) parts.push(`Ligne trop longue (au-delà de ${MEASURE_MAX}) : réduire la largeur ou grossir le texte.`);
    else if (chars < MEASURE_MIN) parts.push(`Ligne courte (moins de ${MEASURE_MIN}) : élargir le texte ou réduire sa taille.`);
    if (lopsided) parts.push(cats.measure.length ? 'Marges déséquilibrées.' : 'Marges déséquilibrées, et aucune variable de largeur à régler : voir le LISEZ-MOI du skill, étape Variables.');
    report.textContent = parts.join(' ');
    report.classList.toggle('warn', lopsided || chars > MEASURE_MAX || chars < MEASURE_MIN);
    $('balance').disabled = !cats.measure.length || !lopsided;
  }
  // Widens or narrows the text column until its right margin matches the left one. Linear: the measure variables scale with k.
  $('balance').addEventListener('click', () => {
    if (!measureInfo) return;
    const target = measureInfo.width + measureInfo.right - measureInfo.left;
    const k = state.globals.measure * (target / measureInfo.width);
    state.globals.measure = Math.min(Math.max(Number(k.toFixed(3)), SLIDERS.measure.min), SLIDERS.measure.max);
    render();
    syncAll();
    commit();
  });
  function setText(change) {
    Object.assign(state.text, change);
    render();
    syncAll();
    commit();
  }
  // Justified text needs hyphenation, or the browser stretches the spaces between words (Butterick).
  $('align-left').addEventListener('click', () => setText({ align: null }));
  $('align-justify').addEventListener('click', () => setText({ align: 'justify', hyphens: true, pretty: true }));
  $('hyphens').addEventListener('change', (e) => setText({ hyphens: e.target.checked }));
  $('pretty').addEventListener('change', (e) => setText({ pretty: e.target.checked }));
  function syncText() {
    $('align-left').setAttribute('aria-pressed', String(!state.text.align));
    $('align-justify').setAttribute('aria-pressed', String(state.text.align === 'justify'));
    $('hyphens').checked = state.text.hyphens;
    $('pretty').checked = state.text.pretty;
    const hint = $('text-hint');
    const noLang = !root.getAttribute('lang');
    hint.textContent = noLang && state.text.hyphens ? 'Le document n\'a pas d\'attribut lang sur <html> : sans langue, le navigateur ne coupe aucun mot.'
      : state.text.align && !state.text.hyphens ? 'Justifié sans césure : les espaces entre les mots vont s\'étirer.'
      : 'Lignes harmonisées : le navigateur répartit mieux les mots et évite un mot seul en dernière ligne.';
    hint.classList.toggle('warn', (noLang && state.text.hyphens) || (Boolean(state.text.align) && !state.text.hyphens));
  }

  // ---------- advanced: every variable ----------
  const rows = new Map();
  function lengthBounds(num, unit) {
    const u = unit.toLowerCase();
    const a = Math.abs(num);
    if ((u === 'em' || u === 'rem') && a < 0.5) {
      const max = Math.max(a * 4, 0.2); // letter-spacing and small offsets need a fine scale
      return { min: num < 0 ? -max : 0, max, step: 0.005 };
    }
    const step = { px: a < 4 ? 0.5 : 1, rem: 0.025, em: 0.025, mm: 0.5, cm: 0.05, pt: 0.5, pc: 0.1, in: 0.01, q: 1, '%': 1 }[u] ?? 0.5;
    const max = u === '%' ? Math.max(a * 2, 100) : ['vw', 'vh', 'vmin', 'vmax'].includes(u) ? 100 : Math.max(a * 3, { px: 48, rem: 4, em: 4 }[u] ?? 10);
    return { min: num < 0 ? -max : 0, max, step };
  }
  function numberBounds(num) {
    if (Number.isInteger(num) && num >= 100 && num <= 900 && num % 100 === 0) return { min: 100, max: 900, step: 100 }; // font weights
    const a = Math.abs(num);
    const max = Math.max(a * 3, 3);
    return { min: num < 0 ? -max : 0, max, step: a <= 3 ? 0.01 : 1 };
  }
  function editVar(v, value, final) {
    if (value === v.initial) state.explicit.delete(v.name);
    else state.explicit.set(v.name, value);
    if (mapping.get(v.name)) state.palette = { ...state.palette, dirty: true };
    render();
    if (final) { syncAll(); commit(); }
  }
  function buildRow(v) {
    const row = el('div', { class: 'vrow' });
    const head = el('div', { class: 'vhead' });
    const usage = v.effect > 0 ? `${v.effect} él.` : v.referenced ? 'hors écran' : 'inutilisée';
    const usageTitle = v.effect > 0 ? `Change ${v.effect} élément(s) de la page`
      : v.referenced ? 'Utilisée seulement à l\'impression, dans un état (survol, focus) ou sur un élément absent' : 'Aucune règle CSS de ce document ne la lit';
    const reset = el('button', { class: 'mini', type: 'button', title: 'Valeur d\'origine', 'aria-label': `${v.name} : valeur d'origine` }, '↺');
    head.append(el('code', {}, v.name), el('span', { class: 'uses', title: usageTitle }, usage), reset);
    const ctl = el('div', { class: 'vctl' });
    let show;
    if (v.kind === 'length' || v.kind === 'number') {
      const parsed = v.kind === 'length' ? parseLength(v.initial) : { num: Number(v.initial), unit: '' };
      const b = v.kind === 'length' ? lengthBounds(parsed.num, parsed.unit) : numberBounds(parsed.num);
      const range = el('input', { type: 'range', min: b.min, max: b.max, step: b.step, 'aria-label': v.name });
      const num = el('input', { type: 'number', step: b.step, 'aria-label': `${v.name}, valeur` });
      ctl.append(range, num, el('span', { class: 'unit' }, parsed.unit));
      const value = (n) => `${Number(Number(n).toFixed(4))}${parsed.unit}`;
      range.addEventListener('input', () => { num.value = range.value; editVar(v, value(range.value), false); });
      range.addEventListener('change', () => editVar(v, value(range.value), true));
      num.addEventListener('change', () => { if (num.value !== '' && !Number.isNaN(Number(num.value))) editVar(v, value(num.value), true); });
      show = (val) => { const n = v.kind === 'length' ? parseLength(val)?.num : Number(val); if (n !== undefined && !Number.isNaN(n)) { range.value = n; num.value = n; } };
    } else if (v.kind === 'color') {
      const picker = el('input', { type: 'color', 'aria-label': `${v.name}, nuancier` });
      const field = el('input', { type: 'text', 'aria-label': `${v.name}, valeur CSS` });
      const role = el('select', { 'aria-label': `${v.name}, rôle` });
      role.append(el('option', { value: '' }, 'Sans rôle'));
      for (const r of ROLES) role.append(el('option', { value: r.id }, r.label));
      role.value = mapping.get(v.name) ?? '';
      role.addEventListener('change', () => {
        if (role.value) mapping.set(v.name, role.value);
        else mapping.delete(v.name);
        mappingDirty = true;
        renderMappingBar();
        renderRoles();
        renderGallery();
      });
      ctl.append(picker, field, role);
      picker.addEventListener('input', () => { field.value = picker.value; editVar(v, picker.value, false); });
      picker.addEventListener('change', () => editVar(v, picker.value, true));
      field.addEventListener('change', () => {
        const val = field.value.trim();
        const ok = isColor(val);
        field.classList.toggle('invalid', !ok);
        if (ok) editVar(v, val, true);
        else setStatus(`Couleur non reconnue pour ${v.name}.`, true);
      });
      show = (val) => { field.value = val; picker.value = hex(rgba(val)); field.classList.remove('invalid'); role.value = mapping.get(v.name) ?? ''; };
    } else {
      const field = el('input', { type: 'text', 'aria-label': v.name });
      ctl.append(field);
      field.addEventListener('change', () => {
        const val = field.value.trim();
        const ok = val && !FORBIDDEN.test(val);
        field.classList.toggle('invalid', !ok);
        if (ok) editVar(v, val, true);
        else setStatus(`Valeur refusée pour ${v.name} : vide ou contenant ; { } < >.`, true);
      });
      show = (val) => { field.value = val; field.classList.remove('invalid'); };
    }
    reset.addEventListener('click', () => { state.explicit.delete(v.name); render(); syncAll(); commit(); });
    row.append(head, ctl);
    rows.set(v.name, { row, show, v });
    return row;
  }
  const GROUPS = [
    { kind: 'color', label: 'Couleurs' },
    { kind: 'length', label: 'Dimensions' },
    { kind: 'number', label: 'Nombres' },
    { kind: 'other', label: 'Autres : polices, ombres, valeurs composées' },
  ];
  const groupCounts = new Map();
  function buildAdvanced(unreadable) {
    const box = $('groups');
    if (!vars.length) box.append(el('p', { class: 'empty' }, 'Aucune variable CSS déclarée sur :root dans ce document.'));
    for (const g of GROUPS) {
      const items = vars.filter((v) => v.kind === g.kind);
      if (!items.length) continue;
      const details = el('details', g.kind === 'color' ? { open: '' } : {});
      const count = el('span', { class: 'count' });
      const summary = el('summary', {}, g.label);
      summary.append(' ', count);
      details.append(summary);
      const active = items.filter((v) => v.effect > 0);
      const idle = items.filter((v) => !v.effect);
      for (const v of active) details.append(buildRow(v));
      if (!active.length) details.append(el('p', { class: 'hint' }, 'Aucune de ces variables ne change la page à l\'écran.'));
      if (idle.length) {
        const rest = el('details', { class: 'idle' });
        rest.append(el('summary', {}, `Sans effet à l'écran (${idle.length})`));
        rest.append(el('p', { class: 'hint' }, '« hors écran » : lue à l\'impression, dans un état ou par un élément absent ; vérifie avec Aperçu impression. « inutilisée » : aucune règle ne la lit.'));
        for (const v of idle) rest.append(buildRow(v));
        details.append(rest);
      }
      groupCounts.set(g.kind, { count, total: items.length });
      box.append(details);
    }
    if (unreadable) box.append(el('p', { class: 'hint' }, `${unreadable} feuille(s) de style externe(s) illisible(s) : leurs variables n'apparaissent pas.`));
  }
  function renderMappingBar() {
    const box = $('mapping-bar');
    box.replaceChildren();
    const save = el('button', { type: 'button' }, 'Mémoriser les rôles pour ce design system');
    save.disabled = !mappingDirty;
    save.title = `Clé : ${mappingKeyValue}`;
    save.addEventListener('click', async () => {
      try {
        await post('correspondance', { cle: mappingKeyValue, roles: Object.fromEntries(mapping) });
        mappingDirty = false;
        renderMappingBar();
        setStatus('Rôles mémorisés : les prochains documents de ce design system les reprendront.');
      } catch (error) { setStatus(error.message, true); }
    });
    box.append(save);
  }
  function applyFilter() {
    const q = $('filter').value.trim().toLowerCase();
    const only = $('only-changed').checked;
    const target = computeTarget();
    for (const [name, r] of rows) {
      const changed = target.has(name) && target.get(name) !== r.v.initial;
      r.row.hidden = (q && !name.toLowerCase().includes(q)) || (only && !changed);
    }
  }
  $('filter').addEventListener('input', applyFilter);
  $('only-changed').addEventListener('change', applyFilter);

  // ---------- hiding sections ----------
  let picking = false;
  let chain = [];
  let level = 0;
  let hoverEl = null;
  function describe(node) {
    const text = (node.innerText || node.textContent).replace(/\s+/g, ' ').trim().slice(0, 60);
    return `<${node.tagName.toLowerCase()}> ${text || node.className || ''}`.trim();
  }
  function setHover(node) {
    hoverEl?.removeAttribute('data-tweak-hover');
    hoverEl = node;
    node?.setAttribute('data-tweak-hover', '');
    $('pick-info').textContent = node ? `Zone : ${describe(node)}` : '';
  }
  function stopPicking() {
    picking = false;
    setHover(null);
    $('pick').textContent = 'Choisir une section à masquer';
    $('pick-hint').hidden = true;
  }
  function renderHidden() {
    const list = $('hidden-list');
    list.replaceChildren();
    for (const [id, item] of state.hidden) {
      const li = el('li');
      const restore = el('button', { type: 'button' }, 'Afficher');
      restore.addEventListener('click', () => {
        item.node.removeAttribute('data-tweak-hidden');
        state.hidden.delete(id);
        renderHidden();
        scheduleContrast();
        commit();
      });
      li.append(el('span', { title: item.label }, item.label), restore);
      list.append(li);
    }
    if (state.hidden.size) list.append(el('li', { class: 'hint' }, mode === 'explore' ? 'Retirées de l\'essai seulement.' : 'Retirées du fichier à l\'enregistrement. Une copie de l\'original est gardée.'));
  }
  $('pick').addEventListener('click', () => {
    if (picking) return stopPicking();
    picking = true;
    $('pick').textContent = 'Terminer le masquage';
    $('pick-hint').hidden = false;
  });
  document.addEventListener('mouseover', (e) => {
    if (!picking || e.target === host) return;
    chain = [];
    for (let n = e.target; n && n !== document.body; n = n.parentElement) if (n.hasAttribute('data-tweak-id')) chain.push(n);
    level = 0;
    setHover(chain[0] ?? null);
  }, true);
  document.addEventListener('click', (e) => {
    if (!picking || e.target === host) return;
    e.preventDefault();
    e.stopPropagation();
    if (!hoverEl) return;
    const node = hoverEl;
    const label = describe(node); // before hiding: innerText of a hidden element loses its line breaks
    setHover(null);
    node.setAttribute('data-tweak-hidden', '');
    state.hidden.set(Number(node.dataset.tweakId), { node, label });
    renderHidden();
    scheduleContrast();
    commit();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!picking) return;
    if (e.key === 'Escape') stopPicking();
    else if (e.key === 'ArrowUp' && level < chain.length - 1) setHover(chain[++level]);
    else if (e.key === 'ArrowDown' && level > 0) setHover(chain[--level]);
    else return;
    e.preventDefault();
  }, true);

  // ---------- contrast ----------
  let contrastTimer = null;
  let issues = [];
  function scheduleContrast() {
    clearTimeout(contrastTimer);
    contrastTimer = setTimeout(checkContrast, RECHECK_DELAY_MS);
  }
  function backgroundOf(node, cache) {
    if (cache.has(node)) return cache.get(node);
    const cs = getComputedStyle(node);
    const own = rgba(cs.backgroundColor);
    const image = cs.backgroundImage !== 'none';
    let result;
    if (own[3] >= 1) result = { color: own, image };
    else {
      const parent = node.parentElement ? backgroundOf(node.parentElement, cache) : { color: [255, 255, 255, 1], image: false };
      result = { color: own[3] > 0 ? over(own, parent.color) : parent.color, image: image || parent.image };
    }
    cache.set(node, result);
    return result;
  }
  function checkContrast() {
    const cache = new Map();
    const pairs = new Map();
    const elements = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode.parentElement;
      if (node && walker.currentNode.nodeValue.trim()) elements.add(node);
    }
    let checked = 0;
    let lowest = Infinity;
    let uncertain = 0;
    for (const node of elements) {
      if (node.closest('script,style,noscript,template') || !node.getClientRects().length) continue;
      const cs = getComputedStyle(node);
      if (cs.visibility === 'hidden') continue;
      const bg = backgroundOf(node, cache);
      if (bg.image) { uncertain++; continue; }
      const fg = over(rgba(cs.color), bg.color);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const threshold = large ? CONTRAST_LARGE : CONTRAST_NORMAL;
      const value = ratio(fg, bg.color);
      checked++;
      lowest = Math.min(lowest, value);
      if (value >= threshold) continue;
      const key = `${hex(fg)}|${hex(bg.color)}|${threshold}`;
      const pair = pairs.get(key) ?? { fg: hex(fg), bg: hex(bg.color), threshold, value, count: 0, first: node };
      pair.count++;
      pairs.set(key, pair);
    }
    issues = [...pairs.values()].sort((a, b) => a.value - b.value);
    const summary = $('contrast-summary');
    const list = $('contrast-list');
    list.replaceChildren();
    if (!checked) { summary.className = 'hint'; summary.textContent = 'Aucun texte visible à contrôler.'; }
    else if (!issues.length) { summary.className = 'hint ok'; summary.textContent = `Tous les textes passent le seuil AA (minimum ${fr(lowest)}:1, ${checked} éléments).`; }
    else { summary.className = 'hint warn'; summary.textContent = `${issues.length} couple(s) texte et fond sous le seuil AA. Clique pour voir l'endroit.`; }
    if (uncertain) summary.textContent += ` ${uncertain} texte(s) sur image ou dégradé non mesurés.`;
    $('t-check').textContent = issues.length ? `Contrôle · ${issues.length}` : 'Contrôle';
    for (const issue of issues.slice(0, 12)) {
      const li = el('li', { class: 'issue', title: 'Afficher dans la page', tabindex: '0' });
      const dot = el('span', { class: 'dot' });
      dot.style.background = issue.bg;
      dot.style.boxShadow = `inset 0 0 0 4px ${issue.bg}, inset 0 0 0 16px ${issue.fg}`;
      li.append(dot, el('span', {}, `${fr(issue.value)}:1 (seuil ${fr(issue.threshold)}), ${issue.count} élément(s)`));
      const show = () => {
        issue.first.scrollIntoView({ block: 'center', behavior: 'smooth' });
        issue.first.setAttribute('data-tweak-flash', '');
        setTimeout(() => issue.first.removeAttribute('data-tweak-flash'), 1500);
      };
      li.addEventListener('click', show);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') show(); });
      list.append(li);
    }
  }

  // ---------- header, sync ----------
  function syncHeader() {
    const p = state.palette;
    const chip = $('chip');
    chip.replaceChildren(el('b', {}, p.source === 'document' && !p.dirty ? 'Original' : p.nom));
    if (p.dirty) chip.append(' · modifiée');
    // Fonts kept from an earlier full style (then a colours-only click) would otherwise pass for this palette's.
    const own = p.source === 'integree' ? data.integrees.find((x) => x.id === p.id)?.style : null;
    const active = [state.fonts.heading, state.fonts.body].filter(Boolean).map((f) => f.label);
    if (active.length && !(own && state.fonts.heading?.label === own.titres && state.fonts.body?.label === own.texte)) {
      chip.append(` · polices ${[...new Set(active)].join(' / ')}`);
    }
    chip.title = chip.textContent;
    $('undo').disabled = !history.past.length;
    $('redo').disabled = !history.future.length;
  }
  function syncFonts() {
    $('font-heading').value = state.fonts.heading?.key ?? '';
    $('font-body').value = state.fonts.body?.key ?? '';
    $('font-code').value = state.fonts.code?.key ?? '';
  }
  function syncAdvanced() {
    const target = computeTarget();
    for (const [name, r] of rows) {
      const value = target.get(name) ?? r.v.initial;
      r.show(value);
      r.row.classList.toggle('changed', value !== r.v.initial);
    }
    for (const [kind, { count, total }] of groupCounts) {
      const changed = vars.filter((v) => v.kind === kind && target.has(v.name) && target.get(v.name) !== v.initial).length;
      count.textContent = changed ? `(${total}, ${changed} modifiée${changed > 1 ? 's' : ''})` : `(${total})`;
    }
    applyFilter();
  }
  function syncAll() {
    syncHeader();
    renderGallery();
    renderRoles();
    syncFonts();
    syncSliders();
    syncText();
    syncAdvanced();
    renderHidden();
  }

  // ---------- header actions ----------
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  const isEditable = (node) => node && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName));
  const onKey = (e) => {
    if (!(e.ctrlKey || e.metaKey) || isEditable(e.composedPath()[0])) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { undo(); e.preventDefault(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { redo(); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);
  function showOriginal(on) {
    if (on === showingOriginal) return;
    showingOriginal = on;
    $('original').setAttribute('aria-pressed', String(on));
    if (on) {
      for (const name of applied) root.style.removeProperty(name);
      fixedRuleStyle.disabled = true;
      for (const item of state.hidden.values()) item.node.removeAttribute('data-tweak-hidden');
      setStatus('Original affiché : relâche pour revenir à tes réglages.');
    } else {
      fixedRuleStyle.disabled = false;
      for (const item of state.hidden.values()) item.node.setAttribute('data-tweak-hidden', '');
      applied = new Set();
      render();
      setStatus('');
    }
  }
  const hold = $('original');
  hold.addEventListener('pointerdown', () => showOriginal(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) hold.addEventListener(ev, () => showOriginal(false));
  hold.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); showOriginal(true); } });
  hold.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') showOriginal(false); });
  $('collapse').addEventListener('click', () => {
    const panel = shadow.querySelector('.panel');
    const collapsed = panel.classList.toggle('collapsed');
    $('collapse').textContent = collapsed ? '+' : '–';
    $('collapse').setAttribute('aria-expanded', String(!collapsed));
    $('collapse').title = collapsed ? 'Déplier le panneau' : 'Replier le panneau';
    dock(!collapsed);
  });
  function dock(on) {
    if (on && innerWidth >= DOCK_MIN_VIEWPORT) root.setAttribute('data-tweak-docked', '');
    else root.removeAttribute('data-tweak-docked');
  }
  $('print').addEventListener('click', () => window.print());

  function lockPanel(message) {
    presence?.close();
    window.removeEventListener('beforeunload', warnUnsaved);
    for (const node of shadow.querySelectorAll('input,select,button')) if (node.id !== 'collapse') node.disabled = true;
    stopPicking();
    setStatus(message);
  }
  function bakeOverrides() {
    const target = computeTarget();
    const overrides = {};
    for (const [name, value] of target) {
      if (name.startsWith('--tweak-') || varsByName.get(name)?.initial !== value) overrides[name] = value;
    }
    return overrides;
  }
  armed($('bake'), () => {
    const n = Object.keys(bakeOverrides()).length;
    const h = state.hidden.size;
    return mode === 'explore' ? `Confirmer : essai et proposition (${n} valeur(s))` : `Confirmer : ${n} valeur(s), ${h} section(s) retirée(s)`;
  }, async () => {
    const overrides = bakeOverrides();
    if (!Object.keys(overrides).length && !state.hidden.size) return setStatus('Rien à enregistrer : aucune valeur modifiée, aucune section masquée.');
    const googleFonts = Object.values(state.fonts).filter((f) => f?.google).map((f) => f.google);
    setStatus(googleFonts.length ? 'Enregistrement : téléchargement des polices…' : 'Enregistrement…');
    try {
      const res = await post('bake', {
        overrides,
        initial: Object.fromEntries(Object.keys(overrides).map((name) => [name, varsByName.get(name)?.initial ?? '(nouvelle)'])),
        hidden: [...state.hidden.keys()],
        hiddenLabels: [...state.hidden.values()].map((item) => item.label),
        contrast: issues.map((i) => `Texte ${i.fg} sur ${i.bg} : ${fr(i.value)}:1, seuil ${fr(i.threshold)}, ${i.count} élément(s)`),
        googleFonts,
        palette: state.palette.dirty ? `${state.palette.nom} (modifiée)` : state.palette.nom,
        fontSummary: [state.fonts.heading && `titres ${state.fonts.heading.label}`, state.fonts.body && `texte ${state.fonts.body.label}`, state.fonts.code && `code ${state.fonts.code.label}`].filter(Boolean),
      });
      const fonts = res.fonts?.length ? ` Polices intégrées : ${res.fonts.join(', ')}.` : '';
      lockPanel(mode === 'explore'
        ? `Essai : ${res.essai}. Proposition : ${res.proposal}. Le document n'a pas changé.${fonts} Tu peux fermer cet onglet.`
        : `Enregistré. Copie de l'original : ${res.backup}.${fonts} Tu peux fermer cet onglet.`);
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  armed($('quit'), () => 'Confirmer : quitter sans rien écrire', async () => {
    try {
      await post('exit');
      lockPanel('Session fermée, aucun fichier modifié. Tu peux fermer cet onglet.');
    } catch (error) { setStatus(error.message, true); }
  });

  // ---------- start ----------
  async function init() {
    const result = collectRootVars();
    vars = result.vars;
    for (const v of vars) varsByName.set(v.name, v);
    document.body.appendChild(host);
    dock(true);
    setStatus(`Mesure de l'effet de ${vars.length} variables…`);
    const loading = fetch(api('donnees')).then((r) => r.json());
    await measureEffects(vars);
    const referenced = referencedVariables();
    for (const v of vars) v.referenced = referenced.has(v.name);

    const loaded = await loading;
    if (!loaded.ok) throw new Error(loaded.error || 'Données de tweak illisibles.');
    Object.assign(data, { integrees: loaded.integrees, mes: loaded.mes, polices: loaded.polices, regles: loaded.regles ?? {} });

    const colorVars = vars.filter((v) => v.kind === 'color');
    mappingKeyValue = mappingKey(colorVars);
    const saved = loaded.correspondances?.[mappingKeyValue];
    if (saved) {
      mapping = new Map(Object.entries(saved).filter(([name]) => varsByName.has(name)));
    } else {
      for (const v of colorVars) { const role = v.effect > 0 || v.referenced ? guessRole(v) : null; if (role) mapping.set(v.name, role); }
      // Small documents often name their brand colour "accent": it then plays the primary role.
      if (![...mapping.values()].includes('primary')) for (const [name, role] of mapping) if (role === 'accent') mapping.set(name, 'primary');
      // Two page colours: the one named as the page (bg, page, paper, canvas) stays the page, the other is the card surface.
      const pages = [...mapping].filter(([, role]) => role === 'background');
      const named = pages.filter(([name]) => /(bg|background|page|paper|canvas)$/i.test(name));
      if (named.length && new Set(pages.map(([name]) => hex(rgba(varsByName.get(name).initial)))).size > 1) {
        for (const [name] of pages) if (!named.some(([n]) => n === name)) mapping.set(name, 'surface');
      }
      // A block filled with the page colour (a white note on white paper) keeps following the page.
      const paper = [...mapping].find(([, role]) => role === 'background');
      if (paper) {
        const base = hex(rgba(varsByName.get(paper[0]).initial));
        for (const [name, role] of mapping) if (role === 'surface' && hex(rgba(varsByName.get(name).initial)) === base) mapping.set(name, 'background');
      }
    }

    for (const v of vars) {
      const p = v.props ?? new Set();
      if (v.kind === 'length' && p.has('font-size') && !/(track|spacing|letter)/i.test(v.name)) cats.fontSize.push(v);
      else if (v.kind === 'number' && p.has('line-height')) cats.line.push(v);
      else if (v.kind === 'length' && RADIUS_PROPS.some((x) => p.has(x)) && !SPACING_PROPS.some((x) => p.has(x))) cats.radius.push(v);
      else if (v.kind === 'length' && SPACING_PROPS.some((x) => p.has(x))) cats.spacing.push(v);
      else if (v.kind === 'length' && v.effect > 0 && p.has('max-width')) cats.measure.push(v);
    }
    // The text font is the font variable that reaches the most elements, not the first declared: a document that
    // declares --font-serif (its headings) before --font-sans (its text) would otherwise keep its text font.
    // A second font variable not named for headings is read as the display font, since text and code are taken.
    const fontVars = vars.filter((v) => v.kind === 'other' && v.props?.has('font-family') && !/(wordmark|logo|brand)/i.test(v.name));
    cats.fonts.code = fontVars.find((v) => /mono|code/i.test(v.name)) ?? null;
    const proseFonts = fontVars.filter((v) => v !== cats.fonts.code).sort((a, b) => b.effect - a.effect);
    cats.fonts.heading = proseFonts.find((v) => /(head|display|title)/i.test(v.name)) ?? null;
    cats.fonts.body = proseFonts.find((v) => v !== cats.fonts.heading) ?? null;
    cats.fonts.heading ??= proseFonts.find((v) => v !== cats.fonts.body) ?? null;
    displayClasses = findDisplayClasses();
    baseSize = [...cats.fontSize].sort((a, b) => b.effect - a.effect)[0] ?? null;

    fontOptions($('font-heading'), true);
    fontOptions($('font-body'), false);
    fontOptions($('font-code'), false);
    buildSliders();
    buildAdvanced(result.unreadable);
    renderMappingBar();
    committed = snapshot();
    opened = committed;
    render();
    syncAll();
    const active = vars.filter((v) => v.effect > 0).length;
    setStatus(`${active} variable(s) sur ${vars.length} changent la page à l'écran. ${mapping.size} couleur(s) rattachée(s) à un rôle${saved ? ' (rôles mémorisés)' : ''}.`);
  }

  // Large text outside h1-h6, such as a chapter number beside its title, reads as a heading: its classes take the
  // heading font. A class qualifies only when every element carrying it is at least 1.6 times the paragraph size.
  function findDisplayClasses() {
    const sizes = [...document.querySelectorAll('p')].filter((e) => !host.contains(e)).map((e) => parseFloat(getComputedStyle(e).fontSize)).sort((a, b) => a - b);
    if (!sizes.length) return [];
    const limit = sizes[Math.floor(sizes.length / 2)] * 1.6;
    const isLarge = (e) => parseFloat(getComputedStyle(e).fontSize) >= limit && !/mono/i.test(getComputedStyle(e).fontFamily);
    const found = new Set();
    for (const e of document.body.querySelectorAll('[class]')) {
      if (host.contains(e) || e.closest('h1, h2, h3, h4, h5, h6, pre, code')) continue;
      if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || !isLarge(e)) continue;
      for (const c of e.classList) if (/^[A-Za-z_][\w-]*$/.test(c) && [...document.getElementsByClassName(c)].every(isLarge)) found.add(c);
    }
    return [...found].slice(0, 12);
  }

  // Keeps the server alive while this tab is open: closing the tab ends the session without writing.
  let presence = null;
  try { presence = new EventSource(api('presence')); } catch { /* old browser: the idle limit still frees the port */ }

  // Closing or reloading the tab drops the panel's state, so the browser asks first while changes are unsaved.
  let opened = '';
  function warnUnsaved(event) {
    if (!opened || snapshot() === opened) return;
    event.preventDefault();
    event.returnValue = ''; // older Chrome and Safari show the prompt only when this is set
  }
  window.addEventListener('beforeunload', warnUnsaved);

  const start = () => init().catch((error) => setStatus(`Panneau non initialisé : ${error.message}`, true));
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start);
})();
