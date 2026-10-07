# Later for Obsidian

Run `npm run build -w @later/obsidian` from the repository, then copy `main.js` and `manifest.json` into your vault's `.obsidian/plugins/later/` directory. Enable Later in Obsidian's community plugin settings. The build uses the repository's existing esbuild executable; Obsidian supplies its runtime API. Minimal local declarations support standalone type checking.

Configure the server origin (default `http://localhost:4800`), API token, and destination folder (default `Later`). Run **Later: Sync Later** from the command palette. While enabled, the plugin also syncs every five minutes using Obsidian's HTTP API, which supports self-hosted servers without browser CORS restrictions.

Sync creates parent directories and writes or overwrites Markdown files under the configured folder. Use a dedicated folder: local edits to synced files are overwritten on the next update. Paths outside that folder and hidden folders are rejected. The cursor is saved only after all writes succeed; a failed batch is retried. Changing server, token, or folder resets the cursor. Article deletions are not propagated by this API.

The token and cursor are stored in Obsidian plugin data in the vault. Use HTTPS for remote servers and protect the vault's plugin data.
