---
name: tweak
description: "Ouvre un HTML local avec un panneau de design en direct (palettes, polices, tailles, marges, sections) et écrit le résultat dans le fichier. Utiliser pour « /tweak », peaufiner un HTML avant un export PDF, changer sa palette ou sa police, ou importer le style d'une marque depuis Refero. Pas pour une application avec serveur de développement."
---

# Tweak

L'utilisateur règle le document à l'œil ; l'IA lance la session, attend, puis vérifie ce qui a été écrit. Seul le serveur écrit, depuis le fichier sur le disque : le HTML enregistré ne contient jamais le panneau ni ce que les scripts de la page ont ajouté.

Ajouter ou mettre à jour le style d'une marque, sans document à régler, ne lance pas de session : suivre [references/importer-un-style.md](references/importer-un-style.md), avec l'URL Refero fournie ou à défaut trouvée par recherche web.

## Règles pour chaque session

1. **Ne pas modifier le fichier pendant une session.** Le serveur refuse l'enregistrement si le fichier a changé depuis l'ouverture, pour ne pas écraser une modification faite ailleurs.
2. **Le mode exploration ne touche jamais au document ni au design system.** Il produit un essai et une proposition. Changer une palette de marque est une décision de l'utilisateur, appliquée ensuite dans la source du design system elle-même.

## Déroulé

```text
Progression :
- [ ] 0 Catalogue de styles vérifié
- [ ] 1 Cible et mode résolus
- [ ] 2 Variables CSS présentes sur :root
- [ ] 3 Session lancée, URL transmise
- [ ] 4 Session terminée par l'utilisateur
- [ ] 5 Résultat vérifié
- [ ] 6 Compte rendu livré
```

**0. Catalogue.** Lister les palettes de `donnees/palettes-integrees.json` qui ont un champ `import`. Chacune doit avoir `roles`, `style` et, dans `donnees/styles/<id>/`, les cinq fichiers listés à l'étape 2 de [references/importer-un-style.md](references/importer-un-style.md). Signaler une palette incomplète par son nom et le fichier manquant, et proposer de relancer son import. Sans palette importée, seules restent les 4 palettes de base en couleurs seules, sans style complet ✦ (polices, arrondi, interligne) : proposer de choisir des marques sur [styles.refero.design](https://styles.refero.design) et de les importer avant la session, ou de continuer ainsi. *Fini quand* l'utilisateur sait quels styles sont disponibles et lesquels manquent.

**1. Cible et mode.** Résoudre le chemin absolu du HTML et le lire. Mode normal par défaut. Mode exploration quand l'utilisateur veut faire évoluer un design system, pour obtenir une proposition au lieu d'un document modifié. *Fini quand* le chemin et le mode sont écrits en une ligne.

**2. Variables.** Le panneau règle les variables déclarées sur `:root` ou `html`, au premier niveau du CSS ou dans un `@media` actif à l'écran. Les lister avec `rg -no -- "--[\w-]+\s*:" <fichier>`, qui trouve aussi celles écrites sur la ligne de `:root{`. Si aucune variable ne porte les couleurs, tailles et espacements, proposer à l'utilisateur de les factoriser d'abord : couleurs principales, taille du texte, tailles des titres, interligne, largeur du texte (le `max-width` des paragraphes), espacement, arrondi. Remplacer les valeurs en dur par `var(--…)`, puis vérifier que le rendu est identique avant de lancer la session. Les polices et l'alignement n'ont pas besoin de variable. *Fini quand* `rg` liste les variables qui pilotent l'apparence.

**3. Lancement.** En tâche de fond, pour que la conversation reste libre. `<skill>` désigne le dossier de ce skill (dans Claude Code, `${CLAUDE_SKILL_DIR}`) :

```bash
node "<skill>/scripts/tweak.mjs" "<fichier.html>"            # mode normal
node "<skill>/scripts/tweak.mjs" "<fichier.html>" --explore  # mode exploration
```

Le script ouvre le navigateur par défaut (`--no-open` l'en empêche) ; sa première ligne de sortie est un JSON `{ ok, url, mode }`. Donner l'URL avec trois repères : « Style complet » applique aussi les polices, l'arrondi et l'interligne d'une palette ✦ ; le bouton ◐, maintenu, montre l'original ; « Aperçu impression » montre les vrais sauts de page. Si la demande vise un réglage précis (marges, couleur d'un rôle, variable), donner aussi son repère, décrit dans [references/fonctionnement.md](references/fonctionnement.md). *Fini quand* l'utilisateur a l'URL.

**4. Attente.** Ne pas interroger le serveur en boucle. Le processus s'arrête de lui-même quand l'utilisateur clique sur Enregistrer ou Quitter, 10 secondes après la fermeture du dernier onglet de la session (un rechargement ne l'arrête pas), ou après trois heures sans requête. Il écrit alors sa dernière ligne JSON (`ended` : `bake`, `exit`, `closed` ou `idle`), et la fin de la tâche de fond le signale. Si l'outil n'a pas de tâche de fond, lancer la commande dans un terminal séparé et attendre que l'utilisateur annonce la fin.

**5. Vérification.** La dernière ligne JSON donne les chemins `backup`, `essai` et `proposal`.
- Mode normal : `git diff --no-index "<backup>" "<fichier>"`. Seuls doivent changer le bloc `<style id="tweak-overrides">` et les sections retirées. Puis ouvrir le fichier dans un navigateur et examiner une capture ; en justifié, chercher les espaces étirés entre les mots, surtout dans les lignes qui contiennent du `code`. Pour un PDF, l'exporter par l'impression en PDF de Chrome ou Chromium, puis contrôler avec `pdffonts` que les polices choisies sont intégrées.
- Mode exploration : ouvrir l'essai et présenter la proposition. Si l'utilisateur valide une palette pour son design system, la changer dans la source qui fait foi, jamais dans un fichier de jetons généré.
- Si l'utilisateur doute qu'un style s'applique, ou après une modification de `panel.js` ou du catalogue : `node "<skill>/scripts/tester-styles.cjs" "<fichier.html>"`. Il rejoue chaque style ✦ dans un navigateur isolé, sans écrire, et sort `ÉCHEC` (code 1) quand une police, l'arrondi ou l'interligne ne suit pas, ou quand l'ordre ou l'annulation diverge.
- Si le diff touche autre chose ou si le rendu est cassé, restaurer depuis la sauvegarde, le signaler, puis revenir à l'étape 3.

*Fini quand* le diff ne contient que les changements attendus et que le rendu a été examiné.

**6. Compte rendu.** Fichiers écrits, sauvegarde, palette et polices retenues, sections retirées, état du contraste, limites rencontrées.

## Fichiers produits

- Mode normal : un seul bloc `tweak-overrides` après le dernier `<style>` (polices Google intégrées en WOFF2, variables `:root`, règles fixes), fusionné à chaque nouvel enregistrement, hors des marqueurs qu'un design system pose dans le document ; une copie horodatée avant chaque écriture dans `<nom>.tweak/sauvegardes/`.
- Mode exploration : l'essai `<nom>.essai-<date>.html` à côté du document, pour que ses chemins relatifs fonctionnent, et `<nom>.tweak/proposition-<date>.md`.
- Les deux : palettes enregistrées et rôles mémorisés dans `donnees/mes-palettes.json` et `donnees/correspondances.json`.

## Ressources

- [references/fonctionnement.md](references/fonctionnement.md) : le panneau onglet par onglet, comment il mesure les variables, devine les rôles de couleur et applique palettes et polices, et ses limites connues. L'ouvrir quand un réglage ne fait rien, qu'une couleur prend un mauvais rôle, qu'un style ne s'applique pas, qu'un rendu surprend, ou avant de modifier `panel.js`.
- `scripts/tweak.mjs` : à lancer, jamais à lire pour l'utiliser. Serveur sur `127.0.0.1` derrière un jeton aléatoire, limité au dossier du document. Node 18 ou plus récent, sans dépendance.
- `scripts/panel.js` : le panneau injecté dans la page. À lire seulement pour le modifier.
- `scripts/importer-style.mjs` : importe une page Refero dans `donnees/styles/<marque>/`.
- `scripts/tester-styles.cjs` : demande Playwright, installé dans le dossier du skill (`npm i playwright` ; Chrome installé sous Windows, `npx playwright install chromium` ailleurs) et au moins un style importé.
- `donnees/palettes-integrees.json` et `donnees/polices.json` (15 piles système, 35 familles Google Fonts) : les catalogues, à lire pour y ajouter une palette ou une police.
- `evals/tests.md` : les prompts de test du skill.
