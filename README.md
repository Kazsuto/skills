# Skills

Skills d'agents IA au format [Agent Skills](https://agentskills.io) : un dossier par skill, avec un fichier `SKILL.md`. Ils fonctionnent avec Claude Code, Codex et OpenCode.

## Installer

Tous les skills :

```bash
npx skills add Kazsuto/skills
```

Un seul skill :

```bash
npx skills add Kazsuto/skills --skill <nom>
```

Copier le dossier d'un skill dans `~/.claude/skills/` (Claude Code) ou `~/.agents/skills/` (Codex, OpenCode) fonctionne aussi.

## Organisation

Les skills sont rangés par catégorie dans `skills/<catégorie>/<skill>/`. Les outils les lisent à plat : chaque nom de skill est unique dans tout le dépôt.

| Catégorie | Contenu | Skills |
| --- | --- | --- |
| `design-medias` | Design, images, logos, présentations | [tweak](skills/design-medias/tweak/README.md) |

## Licence

[MIT](LICENSE)
