# Later HTTP API (FROZEN CONTRACT)

Base: `/api`. JSON in/out. Auth: `Authorization: Bearer <token>` (session or API token) or cookie `later_session`.
Errors: `{ "error": string }` with 4xx/5xx. Server listens on `PORT` (default 4800), data in `LATER_DATA_DIR` (default ./data).

## Auth
- POST /api/auth/signup {email,password} -> 201 {user, token}   (disabled when LATER_SIGNUPS=off, except first user)
- POST /api/auth/login {email,password} -> {user, token}  (also sets httpOnly cookie)
- POST /api/auth/logout -> 204
- GET  /api/me -> {user}
- PATCH /api/me {kindleEmail?} -> {user}
- POST /api/tokens {label} -> 201 {token}   (API token for extension/bookmarklet/obsidian; shown once)

## Articles
- GET  /api/articles?state=inbox|archived|all&tag=&favorite=1&q=&limit=50&cursor= -> {items: Article[] (contentHtml=""), nextCursor}
- POST /api/articles {url, html?, title?, tags?, source?} -> 201 Article
    html present => extract from provided DOM (extension/bookmarklet path; never refetch). Else server fetch.
    Server fetch failure => article saved with captureStatus "failed" (never lost); 201 still returned.
    Duplicate url => 200 existing article (updated content if html given).
- GET  /api/articles/:id -> Article (with contentHtml)
- PATCH /api/articles/:id {state?, favorite?, progress?, tags?, title?} -> Article
- DELETE /api/articles/:id -> 204
- POST /api/articles/:id/refetch -> Article
- GET  /api/search?q= -> {items: (Article & {snippet: string})[]}   (FTS5, snippet with <mark>)
- GET  /api/tags -> {tags: {tag, count}[]}

## Highlights
- GET  /api/articles/:id/highlights -> {items: Highlight[]}
- POST /api/articles/:id/highlights {quote,prefix,suffix,note?,color?} -> 201 Highlight
- PATCH /api/highlights/:id {note?,color?} -> Highlight
- DELETE /api/highlights/:id -> 204
- GET  /api/highlights -> {items: (Highlight & {articleTitle, articleUrl})[]}

## Capture channels
- GET  /share?url=&text=&title=  (PWA share target; redirects to /#/saved/:id)
- GET  /bookmarklet.js (served script)
- POST /api/inbound/email  (header X-Later-Inbound-Secret = LATER_INBOUND_SECRET) body {to, from, subject, html?, text?} -> 201
- GET/POST/DELETE /api/feeds  {url} ; POST /api/feeds/refresh

## Import / export / send
- POST /api/import?format=pocket|omnivore|instapaper|readwise|bookmarks  (raw file body, or multipart "file") -> {imported, skipped, failed}
- GET  /api/export.json -> ExportBundle ; GET /api/export.md.zip -> zip of Markdown files (Obsidian-ready frontmatter)
- GET  /api/articles/:id/epub -> application/epub+zip ; GET /api/export.epub?ids=a,b -> multi-article EPUB
- POST /api/articles/:id/kindle -> 202 (emails EPUB to user.kindleEmail via SMTP_URL; 501 if SMTP not configured)
- GET  /api/obsidian/sync?since=ISO -> {articles: {path, markdown}[], cursor}   (pull API for the Obsidian plugin)

## AI (optional)
- GET  /api/ai/status -> {enabled: boolean, model: string}
- POST /api/articles/:id/summary -> {summary, method: "claude"|"extractive"}
- POST /api/ask {question} -> {answer, method: "claude"|"search", sources: {id,title,url}[]}
