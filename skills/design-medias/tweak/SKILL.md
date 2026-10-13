---
name: tweak
description: "Ouvre un HTML local avec un panneau de design en direct (palettes, polices, tailles, marges, sections) et écrit le résultat dans le fichier. Utiliser pour « /tweak », peaufiner un HTML avant un export PDF, changer sa palette ou sa police, ou importer le style d'une marque depuis Refero. Pas pour une application avec serveur de développement."
---

# Tweak

L'utilisateur règle le document à l'œil ; l'IA lance la session, attend, puis vérifie ce qui a été écrit. Le panneau ne change que la page affichée. Seul le serveur écrit, depuis le fichier sur le disque. Le HTML enregistré ne contient donc jamais le panneau ni ce que les scripts de la page ont ajouté.

Ajouter ou mettre à jour le style d'une marque, sans document à régler, ne lance pas de session : suivre [references/importer-un-style.md](references/importer-un-style.md), avec l'URL Refero fournie ou à défaut trouvée par recherche web.

## Règles pour chaque session

1. **Ne pas modifier le fichier pendant une session.** Le serveur refuse l'enregistrement si le fichier a changé depuis l'ouverture, pour ne pas écraser une modification faite ailleurs.
2. **Le mode exploration ne touche jamais au document ni au design system.** Il produit un essai et une proposition. Le changement d'une palette de marque est une décision de l'utilisateur, appliquée ensuite dans la source du design system elle-même.
3. **Ne jamais désactiver la copie de sauvegarde ni la double confirmation.** Ce sont elles qui rendent l'enregistrement réversible et volontaire.

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

**0. Catalogue.** Le skill est livré sans style de marque : seuls 4 design systems publics (Radix, Primer, shadcn, Material 3), en couleurs seules. Lire `donnees/palettes-integrees.json` et lister les palettes qui ont un champ `import`. Pour chacune, vérifier que son dossier `donnees/styles/<id>/` contient les cinq fichiers de l'import : `style.json`, `mesures.json`, `variables.css`, `source.json` et `design-md.txt`, et que l'entrée a `roles` et `style`. Signaler toute palette incomplète par son nom et le fichier manquant, et proposer de relancer son import. Si aucune palette n'a d'`import`, le dire clairement : le style complet ✦ (polices, arrondi, interligne) n'est pas disponible. Recommander alors de parcourir [styles.refero.design](https://styles.refero.design), de choisir une ou plusieurs marques, puis de les importer selon [references/importer-un-style.md](references/importer-un-style.md) avant la session, ou de continuer avec les 4 palettes de base. *Fini quand* l'utilisateur sait quels styles sont disponibles et lesquels manquent.

**1. Cible et mode.** Résoudre le chemin absolu du HTML et le lire. Mode normal par défaut. Mode exploration quand l'utilisateur veut faire évoluer un design system, pour obtenir une proposition au lieu d'un document modifié. *Fini quand* le chemin et le mode sont écrits en une ligne.

**2. Variables.** Le panneau règle les variables déclarées sur `:root` ou `html`, au premier niveau du CSS ou dans un `@media` actif à l'écran. Vérifier avec `rg -n "^\s*--[\w-]+\s*:" <fichier>`. Si aucune variable ne porte les couleurs, tailles et espacements, proposer à l'utilisateur de les factoriser d'abord : couleurs principales, taille du texte, tailles des titres, interligne, largeur du texte (le `max-width` des paragraphes), espacement, arrondi. Remplacer les valeurs en dur par `var(--…)`, puis vérifier que le rendu est identique avant de lancer la session. Les polices et l'alignement n'ont pas besoin de variable : le panneau ajoute au besoin ses propres règles. *Fini quand* `rg` liste les variables qui pilotent l'apparence.

**3. Lancement.** En tâche de fond, pour que la conversation reste libre. `<skill>` désigne le dossier de ce skill (dans Claude Code, `${CLAUDE_SKILL_DIR}`) :

```bash
node "<skill>/scripts/tweak.mjs" "<fichier.html>"            # mode normal
node "<skill>/scripts/tweak.mjs" "<fichier.html>" --explore  # mode exploration
```

Le script ouvre le navigateur par défaut ; `--no-open` l'en empêche. Sa première ligne de sortie est un JSON `{ ok, url, mode }`. Donner l'URL à l'utilisateur avec ces repères :
- **Style** : un clic sur une palette, claire ou sombre, restyle fond, blocs, contours et texte ; « Style complet », actif à l'ouverture, applique aussi les polices de titres, de texte et de code d'une palette ✦, son arrondi et son interligne. Ses polices s'affichent sous son nom, car plusieurs marques partagent Inter. En « Couleurs », les polices déjà choisies restent et le bandeau les nomme ; chaque couleur se règle par rôle (fond, texte, primaire…) avec son contraste ; « Enregistrer comme nouvelle palette » la garde pour toutes les sessions.
- **Mise en page du texte** (onglet Style) : le panneau affiche la longueur de ligne et les marges du texte, à gauche et à droite. « Équilibrer les marges » élargit le texte jusqu'à ce que les deux marges soient égales. Si la ligne dépasse alors 90 caractères, grossir le texte. « Justifié » active aussi la césure et les lignes harmonisées.
- **En-tête** : annuler et rétablir (Ctrl+Z, Ctrl+Maj+Z), bouton ◐ à maintenir pour revoir l'original.
- **Avancé** : chaque variable, avec le rôle de chaque couleur, à corriger puis à mémoriser pour le design system quand le rôle deviné est faux.
- **Aperçu impression** pour voir les vrais sauts de page.

*Fini quand* l'utilisateur a l'URL.

**4. Attente.** Ne pas interroger le serveur en boucle. Le processus s'arrête de lui-même quand l'utilisateur clique sur Enregistrer ou Quitter, ou après trois heures d'inactivité. Il écrit alors sa dernière ligne JSON (`ended` : `bake`, `exit` ou `idle`), et la fin de la tâche de fond le signale. Si l'outil n'a pas de tâche de fond, lancer la commande dans un terminal séparé et attendre que l'utilisateur annonce la fin.

**5. Vérification.**
- Mode normal : `git diff --no-index "<sauvegarde>" "<fichier>"`. Seuls doivent changer le bloc `<style id="tweak-overrides">` et les sections retirées. Puis ouvrir le fichier dans un navigateur et examiner une capture. En justifié, examiner le rendu pour repérer les espaces étirés entre les mots, surtout dans les lignes qui contiennent du `code`. Si un PDF est demandé, l'exporter par l'impression en PDF de Chrome ou Chromium, et contrôler avec `pdffonts` que les polices choisies sont intégrées.
- Mode exploration : ouvrir l'essai rendu et présenter la proposition à l'utilisateur. S'il valide une nouvelle palette pour son design system, la changer dans la source qui fait foi selon les règles de ce design system, jamais dans un fichier de jetons généré.
- Si l'utilisateur doute qu'un style s'applique, ou après une modification de `panel.js` ou du catalogue : `node "<skill>/scripts/tester-styles.cjs" "<fichier.html>"`. Il rejoue chaque style ✦ (au moins un style importé requis) dans un navigateur isolé, sans écrire, et relève les polices réellement rendues, l'arrondi et l'interligne. Il signale aussi les styles à la typographie identique, les éléments qui ne changent jamais et tout écart d'ordre ou d'annulation (`ÉCHEC`, code de sortie 1).
- Si le diff touche autre chose ou si le rendu est cassé, restaurer depuis la sauvegarde, le signaler, puis revenir à l'étape 3 pour une nouvelle session.

*Fini quand* le diff ne contient que les changements attendus et que le rendu a été examiné.

**6. Compte rendu.** Fichiers écrits, sauvegarde, palette et polices retenues, sections retirées, état du contraste, limites rencontrées.

## Comment le panneau comprend un document

- **Mesure** : au chargement, chaque variable est essayée puis remise ; le panneau compte les éléments qu'elle change et quelles propriétés. Les variables sans effet sont repliées : « hors écran » quand une règle les lit (impression, survol, élément absent), « inutilisée » sinon. Un design system déclare beaucoup de variables qu'un document n'emploie pas.
- **Rôles de couleur** : fond, surface, fond teinté, aplat foncé, texte, texte secondaire, filets, contour marqué, primaire, accent, statuts, texte sur aplat, texte sur primaire. Devinés d'après le nom et la mesure (`--ink` = texte, `--paper` = fond, `text-2` ou `text-3` = texte secondaire, `surface-quote`, `surface-accent` ou `accent-soft` = fond teinté, `border-note` = contour marqué, `on-primary` = texte sur primaire). Une surface de la couleur du fond suit le fond ; quand deux variables ont l'air d'être le fond, celle nommée `bg`, `page`, `paper` ou `canvas` reste le fond et l'autre devient la surface des cartes. Les couleurs de base d'une gamme (`prusse-600`), les états (`hover`, `focus`) et les variables calculées à partir d'une autre (`var()`, `color-mix()`) n'ont pas de rôle : une couleur dérivée suit sa base, un rôle la figerait. Pour qu'un document suive entièrement une palette, n'écrire en dur que les couleurs de base et tirer teintes, filets et survols par `color-mix()`. Les rôles mémorisés sont rangés par préfixe de design system (`--md-sys-`) et repris aux sessions suivantes.
- **Palette appliquée** : une palette restyle tout le document, fond de page, blocs, contours et texte, et pas seulement ses accents. Un rôle absent est dérivé des couleurs de la palette (accent = primaire, fond teinté = 10 % du primaire dans le fond, filets et surface tirés du texte), car une teinte du document gardée sous une autre palette se lit comme un calque coloré posé dessus. Les statuts gardent la teinte du document. Chaque couleur de texte reste ensuite lisible sur tous les fonds de la palette (page, cartes, teintes) : statuts et texte secondaire sont rapprochés du texte de la palette jusqu'à 4,5:1 ; primaire et accent jusqu'à 4,5:1 quand le CSS du document écrit du texte dans cette couleur, 3:1 sinon ; un primaire de ton moyen est poussé jusqu'à ce que le texte posé dessus atteigne 4,5:1.
- **Ligne et marges** : le texte courant est le paragraphe long le plus répandu parmi ceux qui ont un `max-width`. La page est son plus proche parent qui a un fond, ou le `body`. Une ligne confortable compte de 45 à 90 caractères, espaces compris. Deux marges dont l'écart dépasse 20 % sont signalées comme déséquilibrées. La largeur du texte multiplie les variables qui changent un `max-width`.
- **Polices** : chaque police choisie remplace la variable de police correspondante du document et passe aussi par une règle sur `body` (boutons et champs compris), `code, kbd, samp, pre` ou `h1` à `h6`. La variable du code contient `mono` ou `code`. Celle du texte est la variable qui touche le plus d'éléments, pas la première déclarée. Celle des titres porte `head`, `display` ou `title` dans son nom, ou à défaut c'est l'autre variable de police restante (un `--font-serif` de titres). Les règles des titres et du code passent devant une classe qui fixe sa propre police. Un grand texte hors titre, comme un numéro de chapitre à côté de son titre (toute classe dont chaque élément mesure au moins 1,6 fois le paragraphe), prend la police des titres.
- **Réglages globaux** : la taille du texte multiplie toutes les variables de taille de police ; la hiérarchie élargit ou resserre l'écart entre le corps et les titres ; interligne, densité et arrondi multiplient les variables qui les portent. Une variable modifiée dans Avancé l'emporte.

## Fichiers produits

| Mode | Écrit | Où |
| --- | --- | --- |
| Normal | Le document, avec un seul bloc `tweak-overrides` après le dernier `<style>` : polices Google intégrées en WOFF2 (latin et latin-ext), variables `:root`, règles fixes (polices, alignement, césure, lignes harmonisées). Un nouvel enregistrement fusionne dans ce même bloc | Fichier d'origine |
| Normal | Copie du fichier avant chaque enregistrement, horodatée | `<nom>.tweak/sauvegardes/` |
| Exploration | Essai rendu avec les valeurs testées | `<nom>.essai-<date>.html`, à côté du document pour que ses chemins relatifs fonctionnent |
| Exploration | Proposition : palette, polices, variables avant et après, contraste, sections masquées | `<nom>.tweak/proposition-<date>.md` |
| Les deux | Palettes enregistrées par l'utilisateur ; rôles mémorisés par design system | `donnees/mes-palettes.json`, `donnees/correspondances.json` |

Si un design system délimite ses propres blocs par des marqueurs dans le document, le bloc reste hors de ces marqueurs. Une palette ou une police qui devrait valoir pour tous les documents passe par le mode exploration, puis par le guide du design system.

## Limites connues

- Variables invisibles pour le panneau : celles déclarées sur `body` ou un autre sélecteur, dans `@media print`, ou dans une feuille externe d'une autre origine. Le panneau compte ces feuilles illisibles.
- Les règles `@page` ne lisent pas les variables CSS : les marges d'impression et l'en-tête courant ne se règlent pas ici. Une marge de page écrite en dur (`padding: 20mm`) non plus : pour l'élargir au lieu d'élargir le texte, la factoriser à l'étape 2.
- Alignement, césure et lignes harmonisées s'appliquent à `p`, `li`, `dd`, `blockquote` et `figcaption`. Une règle de classe qui fixe son propre `text-align` l'emporte. La césure exige `lang` sur `<html>` et un dictionnaire dans le navigateur : l'impression en PDF de Chrome coupe le français, mais le Chromium de Playwright ne coupe aucun mot.
- Sans variable de police du texte dans le document, la police du texte passe par `body` : un élément dont une classe fixe sa propre police la garde.
- Une pile système prend la première police installée sur la machine (Charter absente sous Windows : Sitka Text la remplace). Google Fonts demande une connexion pour l'aperçu et à l'enregistrement, plus jamais ensuite.
- Masquage : seulement les blocs qui ont toujours une balise de fermeture (`section`, `div`, `table`, titres, listes…). Pour un `<p>` ou un `<li>`, masquer son parent. Un élément ajouté par un script n'est pas masquable.
- Contraste : un texte posé sur une image ou un dégradé n'est pas mesuré ; le panneau dit combien de textes sont dans ce cas. Les palettes marquées ⚠ ont un primaire ou des accents sous AA en texte : aplats, filets et titres seulement.
- Style complet : il passe par les curseurs. L'arrondi de la marque s'applique exactement au plus grand rayon du document, celui des blocs, et les autres rayons suivent en proportion. L'interligne plafonne à ±25 % et vise le texte courant. Un fichier déjà enregistré a pour « Original » ses valeurs enregistrées. Une police de marque non libre est remplacée par celle que donne Refero.
- Palettes sombres : les fonds pâles des statuts écrits en dur gardent leur couleur claire (les tirer par `color-mix()` les fait suivre), et la page imprimée reste noire. Une couleur écrite en dur dans le CSS (en-têtes `@page`, icônes SVG) ne change pas.
- Les chemins absolus `file:///` ou `C:/` dans le HTML ne se chargent pas à travers le serveur local.
- Le panneau ancré réduit la largeur de la page sans changer celle de la fenêtre : les `@media` d'un document responsive gardent leur mise en page large et une grille peut s'écraser dans l'aperçu. Réduire le panneau (–) pour juger la mise en page.

## Ressources

- `scripts/tweak.mjs` : à lancer, jamais à lire pour l'utiliser. Il sert la page sur `127.0.0.1` derrière un jeton aléatoire, ne sert que les fichiers du dossier du document, enregistre palettes et rôles, télécharge les polices Google du catalogue et fait l'enregistrement. Node 18 ou plus récent, sans dépendance.
- `scripts/panel.js` : le panneau injecté dans la page par le serveur. À lire seulement pour le modifier.
- `donnees/palettes-integrees.json` : livré avec 4 design systems publics en couleurs seules ; chaque style de marque importé s'y ajoute avec le jeton d'origine de chaque rôle et son style complet ✦. Source, licence et lisibilité pour chacune.
- `scripts/importer-style.mjs` en importe la page dans `donnees/styles/<marque>/` (style, mesures, DESIGN.md, CSS).
- `donnees/polices.json` : 15 piles système (Modern Font Stacks, CC0) et 35 familles Google Fonts. À lire pour ajouter une palette ou une police au catalogue.
- `scripts/tester-styles.cjs` : test du style complet sur un HTML, à lancer (Playwright requis, installé dans le dossier du skill : `npm i playwright` ; Chrome installé sous Windows, `npx playwright install chromium` ailleurs).
- `evals/tests.md` : les prompts de test du skill.
