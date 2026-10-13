# Importer un style de marque

Une palette de marque se construit depuis la page Refero Styles de la marque, seule source : ses valeurs sont mesurées sur le site actuel. Mélanger des sources a déjà donné un Linear périmé (lavande au lieu du vert acide).

```text
Import :
- [ ] 1 URL trouvée
- [ ] 2 Page importée
- [ ] 3 Rôles attribués, jeton par jeton
- [ ] 4 Style complet relevé
- [ ] 5 Entrée ajoutée au catalogue
- [ ] 6 Planche de comparaison examinée
```

**1. URL.** Recherche web limitée au domaine `styles.refero.design`, requête « <marque> design system ». Le titre du résultat est « <Marque> design system ». La page est publique, sans compte ; la CLI `refero` et son abonnement ne servent pas ici. Ne jamais parcourir le plan du site : le `robots.txt` de Refero refuse les robots d'IA, on importe une page à la fois, à la demande.

**2. Import.** `node scripts/importer-style.mjs <URL> --slug <id>`. Le script écrit dans `donnees/styles/<id>/` : `style.json` (l'objet dont Refero tire ses fichiers : couleurs avec rôle, surfaces par niveau, polices et remplaçantes, rayons, échelle), `mesures.json` (usage mesuré sur le site), `design-md.txt` (le DESIGN.md), `variables.css`, `source.json`. Il imprime un résumé pour l'étape 3. Si l'objet de style est introuvable, Refero a changé son format : le signaler, ne pas recopier les couleurs à la main depuis une capture.

**3. Rôles.** Chaque rôle de tweak prend un jeton nommé par Refero, d'après sa description, puis `usageMesure` pour trancher :
- `background` : la surface de niveau 0 ou 1 décrite « page canvas ».
- `surface` : la carte posée sur le fond ; `surfaceTint` : la surface teintée ou imbriquée (« tint », « wash », « nested »). Écarter une teinte saturée ou sombre qui alourdirait des blocs de texte : omettre le rôle le fait dériver.
- `text` : la couleur la plus utilisée en `body/color` qui passe 4,5:1, pas forcément celle des titres. `textMuted` : texte secondaire qui passe AA, sinon le noter.
- `border` : « hairline », « divider » ; `borderStrong` : contour ou bordure appuyée.
- `primary` : liens et action ; `accent` : la marque quand elle ne sert qu'en décor. Une couleur « use as a supporting accent » ne devient jamais primaire.
- Ne rien inventer : un rôle sans jeton s'omet et se dérive. Une valeur en transparence s'aplatit sur le fond de la palette, avec une note.

**4. Style complet.** `titres`, `texte` et `code` : la remplaçante libre donnée par Refero quand la police de marque n'est pas sur Google Fonts. Elle doit exister dans `donnees/polices.json` ; sinon l'ajouter au catalogue si elle est sur Google Fonts. Sans mono dans la source, `code` vaut la pile système « Mono code ». `arrondi` : le rayon des cartes. `interligne` : celui du corps de texte, omis s'il est pensé pour une interface (sous 1,3).

**5. Catalogue.** Dans `donnees/palettes-integrees.json` : `source` (URL), `import` (dossier), `roles`, `jetons` (rôle → nom du jeton), `style`, `lisibilite` et `notes` pour tout contraste sous AA. Les marques claires vont avant les sombres.

**6. Contrôle.** Session `--explore` sur un document de référence, la palette en Couleurs puis en Style complet : capture des citations, du code et d'un encadré, examinée. Si un bloc garde une teinte de l'ancien document ou perd sa lisibilité, revenir à l'étape 3.

Mettre à jour une marque : relancer l'import sur la même URL, comparer `style.json` avec la version précédente, puis reprendre l'étape 3 pour les jetons qui ont changé.
