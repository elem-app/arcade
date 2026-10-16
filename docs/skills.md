# Skills

Arcade includes ready-to-use agent skills under `skills/<name>/`. Each directory is self-contained and can be copied or linked into a skill loader such as `.claude/skills/`. Building or starting Arcade preserves these bundled skills.

## `arc-build`

`arc-build` helps write an Arc from an intent. It includes the Arc language specification, authoring patterns, documentation for Arcade's built-in host modules, validation scripts, and a standalone viewer page.

Its scripts require only Node. From the skill directory, run `node scripts/check-arc.mjs <file.arc.js>` to validate an Arc, or `node scripts/view-arc.mjs <file.arc.js>` to write a viewer page with the Arc embedded. Follow `SKILL.md` for the complete authoring workflow.
