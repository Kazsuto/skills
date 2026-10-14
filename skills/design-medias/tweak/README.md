# tweak

Ouvre un fichier HTML local dans le navigateur avec un panneau de design en direct. On règle le document à l'œil : palette, polices, tailles, interligne, largeur du texte, marges, arrondis, sections à masquer. Puis on enregistre, et le résultat est écrit dans le fichier.

Utile pour peaufiner un rapport, un devis ou un guide avant un export PDF, ou pour appliquer le style d'une marque (Linear, Notion, Stripe…) à un vrai document.

## À savoir avant tout : aucun style de marque n'est fourni

Le skill est livré avec seulement 4 palettes de base, en couleurs seules : Radix, Primer, shadcn et Material 3. Les styles de marque, avec leurs couleurs, leurs polices, leur arrondi et leur interligne, c'est toi qui les choisis et les installes, depuis [Refero Styles](https://styles.refero.design).

À chaque session, l'agent vérifie d'abord le catalogue. Il dit quels styles sont installés, signale un style incomplet (un fichier manquant), et te prévient si aucun n'est installé.

## Première utilisation, pas à pas

1. **Installer le skill** (voir plus bas) et vérifier que Node.js 18 ou plus récent est présent : `node --version`.
2. **Choisir tes styles.** Parcourir [styles.refero.design](https://styles.refero.design) et noter les marques dont le style te plaît (par exemple Linear, Notion, Stripe). La page est publique, sans compte.
3. **Les installer** en le demandant à ton agent, une marque à la fois : « ajoute le style de Linear au catalogue de tweak ». L'agent trouve la page, lance l'import, attribue chaque couleur à son rôle et ajoute l'entrée au catalogue. À la main : `node scripts/importer-style.mjs <URL de la page Refero> --slug linear`, puis suivre [references/importer-un-style.md](references/importer-un-style.md).
4. **Lancer une session** sur ton document : `/tweak mon-document.html`. L'agent te donne une URL ; règle le document dans le panneau, puis clique sur Enregistrer.

Tu peux sauter les étapes 2 et 3 et travailler avec les 4 palettes de base ; le « Style complet » (polices, arrondi, interligne d'une marque) ne sera alors pas disponible.

## Prérequis

- Node.js 18 ou plus récent. Le serveur et le panneau n'ont aucune dépendance.
- Optionnel, pour `scripts/tester-styles.cjs` : [Playwright](https://playwright.dev), installé **dans le dossier du skill** (`npm i playwright`), car le script le cherche à partir de son propre dossier. Sous Windows, il utilise Google Chrome déjà installé ; sous macOS et Linux, lancer aussi `npx playwright install chromium`.
- Utilisés par l'agent pendant le déroulé, s'ils sont présents : `rg` (ripgrep) pour lister les variables CSS, `git` pour comparer le document à sa sauvegarde, `pdffonts` (Poppler) pour vérifier les polices d'un PDF.
- Une connexion internet pour importer un style et pour les polices Google, à l'aperçu et à l'enregistrement. Le fichier enregistré intègre ensuite ses polices en WOFF2.

## Installer

```bash
npx skills add Kazsuto/skills --skill tweak
```

Ou copier ce dossier dans `~/.claude/skills/` (Claude Code) ou `~/.agents/skills/` (Codex, OpenCode).

## Utiliser

Avec un agent : `/tweak mon-document.html`, ou « peaufine ce HTML », « change la palette de ce rapport ». L'agent vérifie le catalogue, lance la session, te donne l'URL, attend que tu enregistres, puis vérifie le diff.

Sans agent, depuis le dossier du skill :

```bash
node scripts/tweak.mjs "chemin/vers/document.html"
```

```bash
node scripts/tweak.mjs "chemin/vers/document.html" --explore
```

Options : `--explore` (essai et proposition, le document n'est pas modifié), `--no-open` (n'ouvre pas le navigateur), `--port <n>`.

- **Mode normal** : un clic sur Enregistrer écrit un bloc `<style id="tweak-overrides">` dans le document. Une copie horodatée part avant dans `<nom>.tweak/sauvegardes/`.
- **Mode exploration** : produit `<nom>.essai-<date>.html` et une proposition en Markdown, sans toucher au document.
- **Fermer l'onglet** termine la session sans rien écrire. Si des réglages ne sont pas enregistrés, le navigateur demande d'abord confirmation.

Le panneau règle les variables CSS déclarées sur `:root`. Un HTML plein de valeurs en dur gagne à être factorisé d'abord (couleurs, tailles, interligne, largeur du texte) ; l'agent le propose.

## Données

- `donnees/palettes-integrees.json` : le catalogue. Les 4 palettes de base, puis chaque style importé.
- `donnees/styles/<marque>/` : un dossier par style importé (`style.json`, `mesures.json`, `variables.css`, `source.json`, `design-md.txt`). Vide à l'installation.
- `donnees/polices.json` : piles de polices système et familles Google Fonts.
- Créés à l'usage, propres à chacun et ignorés par Git : `donnees/mes-palettes.json` (tes palettes enregistrées), `donnees/correspondances.json` (les rôles de couleur corrigés) et les `design-md.txt` des imports.

## Limites et reste à faire

- Les limites connues sont listées dans [references/fonctionnement.md](references/fonctionnement.md) : variables hors `:root`, règles `@page`, chemins absolus `file:///` qui ne se chargent pas, césure selon le navigateur.
- L'import dépend du format actuel des pages Refero. Si Refero le change, le script s'arrête avec un message au lieu d'écrire un style faux.
- `tester-styles.cjs` demande au moins un style importé.

## Licence

MIT, comme le dépôt. Les styles importés restent chez toi ; les noms et couleurs des marques appartiennent à leurs propriétaires.
