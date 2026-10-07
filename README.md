# Later

A self-hostable read-it-later app. Pocket shut down and Omnivore went away; Later fills the gap with a small server you own, your data in a single volume, and open formats for getting it out again.

## Features

- Save articles with a browser extension, bookmarklet, mobile share target, email-in or RSS
- Clean reader view, highlights, tags, full-text search
- Send to Kindle, EPUB export
- Import from Pocket, Omnivore, Instapaper, Readwise and browser bookmarks
- Export to JSON or Obsidian-ready Markdown
- Optional AI summaries
- Single Docker image, SQLite storage

## Quick start

Docker:

```sh
docker run -d --name later -p 4800:4800 -v later-data:/data ghcr.io/ysta32/later:latest
```

Compose:

```sh
cp .env.example .env
docker compose up -d
```

From source (Node 24):

```sh
npm ci
npm run build -w apps/web
npm run dev
```

Then open http://localhost:4800. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for configuration.

## Capture channels

- **Browser extension**: load `apps/extension` (or the release zip) and point it at your instance.
- **Bookmarklet**: install it from the app settings page.
- **Share target**: install the web app as a PWA and share links to it from your phone.
- **Email-in**: configure any inbound-email service (Cloudflare Email Workers, Postmark, Mailgun) to POST `{to, from, subject, html?, text?}` to `/api/inbound/email` with the header `X-Later-Inbound-Secret` set to `LATER_INBOUND_SECRET`.
- **RSS**: subscribe to feeds from the app.

## Kindle

Set `SMTP_URL` (for example `smtps://user:pass@smtp.example.com:465`), then add the sender address to your Amazon "Approved Personal Document E-mail List" and enter your Kindle address in settings.

## AI

Set `ANTHROPIC_API_KEY` to enable AI features. `LATER_AI_MODEL` selects the model (default `claude-sonnet-5-5`).

## Import and export

Import via `POST /api/import?format=pocket|omnivore|instapaper|readwise|bookmarks`. Export JSON at `/api/export.json` or a zip of Markdown files with frontmatter at `/api/export.md.zip`, which can be dropped straight into an Obsidian vault.

## API

See [docs/API.md](docs/API.md).

## License

MIT, see [LICENSE](LICENSE).
