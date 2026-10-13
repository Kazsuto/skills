# Tests du skill tweak

Sans le skill, l'IA réécrit à chaque fois un panneau ad hoc. Elle n'a ni serveur pour réécrire le fichier, ni copie de sauvegarde, ni respect des marqueurs d'un template de design system, ni limite de palette, et elle ne sépare pas l'essai de la modification du document.

### Réglage avant PDF
Prompt: /tweak ~/Documents/devis-atelier.html, je veux ajuster les espacements avant l'export
Should trigger: yes
First file Claude should open: le HTML cible, puis lancement de scripts/tweak.mjs en tâche de fond
Done looks like: l'URL est donnée à l'utilisateur ; après son Bake, le diff contre la sauvegarde ne montre que le bloc tweak-overrides et les sections retirées

### Exploration de palette
Prompt: j'aimerais tester une autre couleur primaire pour mon design system sur un vrai document
Should trigger: yes
First file Claude should open: un document existant de ce design system, lancé avec --explore
Done looks like: un fichier essai et une proposition sont produits, le document et les jetons du design system sont intacts, et la proposition est présentée avant tout changement du guide

### HTML sans variables
Prompt: peaufine à la main ce rapport.html, il n'a que des valeurs en px partout
Should trigger: yes
First file Claude should open: rapport.html, puis rg sur les déclarations --
Done looks like: Claude propose de factoriser 5 à 10 variables sur :root et vérifie que le rendu est identique avant de lancer la session

### Ne doit pas déclencher
Prompt: améliore le design de la page d'accueil de mon app Next.js
Should trigger: no
Done looks like: tweak n'est pas chargé ; l'app est modifiée dans son code source

### Changer de palette et de police
Prompt: /tweak sur ce devis, je veux essayer plusieurs palettes et une police plus éditoriale pour les titres
Should trigger: yes
First file Claude should open: le HTML cible, puis lancement de scripts/tweak.mjs en tâche de fond
Done looks like: après l'enregistrement, le bloc tweak-overrides contient les variables de la palette choisie, la police des titres intégrée en WOFF2 si elle vient de Google Fonts, et `pdffonts` la liste dans le PDF exporté

### Texte mal aligné
Prompt: /tweak sur ce guide, le texte n'est pas aligné et il reste beaucoup de blanc à droite
Should trigger: yes
First file Claude should open: le HTML cible, puis rg sur les déclarations -- pour trouver la variable de largeur du texte
Done looks like: la marge droite du texte égale la gauche, la ligne reste sous 90 caractères, le bloc tweak-overrides contient la largeur, `--tweak-text-align: justify` et `--tweak-hyphens: auto`, et le PDF exporté coupe les mots sans espaces étirés

### Palette qui restyle tout le document
Prompt: /tweak sur ce guide, les palettes ne font qu'ajouter une couleur par-dessus, je veux un vrai changement de style
Should trigger: yes
First file Claude should open: le HTML cible, puis lancement de scripts/tweak.mjs en tâche de fond
Done looks like: avec un style importé (ou Radix si aucun), le fond de la page, les fonds des citations et du code, les contours des encadrés et le texte changent ensemble ; aucune teinte d'origine du document ne reste sous la nouvelle palette, hors statuts

### Ajouter le style d'une marque
Prompt: ajoute le style de Linear au catalogue de tweak, en couleurs et en style complet
Should trigger: yes
First file Claude should open: references/importer-un-style.md, puis recherche web limitée à styles.refero.design et scripts/importer-style.mjs sur la seule URL trouvée
Done looks like: donnees/styles/linear/ contient style.json, mesures.json, design-md.txt et variables.css ; l'entrée du catalogue porte un jeton Refero par rôle (Void, Mist, Acid Lime…) et un style Inter / 12px ; la capture en Style complet a été examinée ; aucun parcours du plan du site

### Le style complet semble ne pas changer
Prompt: /tweak, en style complet j'ai l'impression que la typo change une fois sur deux
Should trigger: yes
First file Claude should open: le HTML cible, puis scripts/tester-styles.cjs sur ce fichier
Done looks like: si aucun style n'est importé, Claude le dit et renvoie vers l'import ; sinon le tableau des polices rendues par style est montré, avec les styles à la typographie identique ; le test sort OK, ou chaque élément qui ne suit pas est nommé avec sa cause (classe ou `style` qui fixe sa police)

### Premier usage, catalogue vide
Prompt: /tweak sur ce rapport, je veux lui donner le style de Stripe
Should trigger: yes
First file Claude should open: donnees/palettes-integrees.json, puis le dossier donnees/styles/
Done looks like: Claude signale qu'aucun style de marque n'est installé, renvoie vers styles.refero.design, importe Stripe selon references/importer-un-style.md, vérifie que son dossier est complet, puis lance la session
