# Versioning and releases

One version number, in two places that always match: `extension/manifest.json` and `package.json`. Chrome shows it on `chrome://extensions`, so people can tell which build they have.

## Number scheme: `MAJOR.MINOR.PATCH`

| Bump | When | Who decides |
|---|---|---|
| **PATCH** (0.2.0 → 0.2.1) | fixes, polish, copy, tests; nothing a user would call "new" | Claude, automatically with every release |
| **MINOR** (0.2.x → 0.3.0) | a new feature or a visible change that is not a rewrite | Claude, automatically, and says so |
| **MAJOR** (0.x → 1.0, 1.x → 2.0) | a redesign, a change that breaks saved data or settings, a new permission model, anything worth announcing | **Ask the owner first**, every time. Say why it looks major and propose the number; do not bump until they answer |

Before 1.0 the leading `0.` stays until the owner decides the product is ready for 1.0 (that decision is theirs).

## Releasing

1. Decide the number (table above). Bump it in `extension/manifest.json` and `package.json`.
2. Add a line to `CHANGELOG.md` under that version, with the date.
3. `npm test` and the three Chrome tests (`chrome-smoke`, `chrome-meet`, `chrome-sidepanel`) must pass.
4. `npm run share` builds `release/<YYYY-MM-DD>/Debrief-v<version>.zip`. That one file is what gets sent to people.
5. `release/` keeps one folder per date. Delete older folders when asked; never leave loose zips or staging folders in `release/`.
6. Tag the commit `v<version>` when the owner has said the release is final.

`npm run pack` (store upload build without the dev key) and `npm run src-zip` also write into the dated folder.
