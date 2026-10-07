import { useEffect, useState } from "preact/hooks";
import { api, links } from "../api.ts";
import type { Feed, User } from "../api.ts";
import type { ImportFormat } from "@later/core/types";
import { errorMessage } from "../app.tsx";

export function detectImportFormat(filename: string, data: string): ImportFormat | null {
  const name = filename.toLowerCase();
  if (/omnivore/.test(name) || /"(pageType|labels)"\s*:/.test(data)) return "omnivore";
  if (/readwise/.test(name) || /\b(Highlight|highlight)\b.*\b(Location|location)\b/.test(data))
    return "readwise";
  if (/instapaper/.test(name) || /^URL,Title,Selection,Folder/m.test(data)) return "instapaper";
  if (/pocket|ril_export/.test(name) || /<h1>\s*(Unread|Pocket)/i.test(data)) return "pocket";
  if (/NETSCAPE-Bookmark-file-1|<DL[\s>]/i.test(data)) return "bookmarks";
  return null;
}
export function bookmarklet(origin: string, token: string): string {
  const source = `${origin}/bookmarklet.js?token=${encodeURIComponent(token)}`;
  return `javascript:(()=>{const s=document.createElement('script');s.src=${JSON.stringify(source)};document.body.appendChild(s)})()`;
}
export default function Settings({ user, onUser }: { user: User; onUser: (user: User) => void }) {
  const [kindle, setKindle] = useState(user.kindleEmail ?? "");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("My bookmarklet");
  const [format, setFormat] = useState<ImportFormat | "auto">("auto");
  const [file, setFile] = useState<File | null>(null);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [feedUrl, setFeedUrl] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api
      .feeds()
      .then((r) => setFeeds(r.items))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="settings">
      <p class="eyebrow">Make yourself at home</p>
      <h1>Your settings</h1>
      {error && (
        <p class="notice" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p class="notice" role="status">
          {message}
        </p>
      )}
      <section class="panel">
        <h2>Send to Kindle</h2>
        <p class="muted">Add your Kindle address to send articles from the reader.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              onUser((await api.updateMe({ kindleEmail: kindle.trim() || null })).user);
              setMessage("Kindle address saved.");
            });
          }}
        >
          <label>
            Kindle email
            <input
              type="email"
              value={kindle}
              placeholder="you@kindle.com"
              onInput={(e) => setKindle(e.currentTarget.value)}
            />
          </label>
          <button disabled={busy}>Save address</button>
        </form>
      </section>
      <section class="panel">
        <h2>Save from anywhere</h2>
        <p>
          Email articles to{" "}
          <strong class="break">
            save+{user.inboundToken}@{location.hostname}
          </strong>
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              setToken((await api.createToken(label)).token);
            });
          }}
        >
          <label>
            API token label
            <input required value={label} onInput={(e) => setLabel(e.currentTarget.value)} />
          </label>
          <button disabled={busy}>Create API token</button>
        </form>
        {token && (
          <div class="notice">
            <p>This token is shown once. Keep it private.</p>
            <label>
              API token
              <input readOnly value={token} onFocus={(e) => e.currentTarget.select()} />
            </label>
            <p>
              Drag{" "}
              <a class="button" href={bookmarklet(location.origin, token)}>
                Save to Later
              </a>{" "}
              to your bookmarks bar. Use it while viewing an article.
            </p>
          </div>
        )}
      </section>
      <section class="panel">
        <h2>Bring your reading with you</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (!file) throw new Error("Choose an export file first.");
              const selected = format === "auto" ? detectImportFormat(file.name, await file.text()) : format;
              if (!selected) throw new Error("Could not detect the format. Please choose it from the list.");
              const result = await api.importFile(selected, file);
              setMessage(`Imported ${result.imported}; skipped ${result.skipped}; failed ${result.failed}.`);
            });
          }}
        >
          <label>
            Import format
            <select
              value={format}
              onChange={(e) => setFormat(e.currentTarget.value as ImportFormat | "auto")}
            >
              <option value="auto">Auto detect</option>
              {["pocket", "omnivore", "instapaper", "readwise", "bookmarks"].map((value) => (
                <option key={value} value={value}>
                  {value === "bookmarks" ? "Browser bookmarks" : value[0]!.toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Export file
            <input type="file" required onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
          </label>
          <button disabled={busy || !file}>Import reading</button>
        </form>
        <h3>Back up your library</h3>
        <div class="actions">
          <a href={links.exportJson}>Download JSON</a>
          <a href={links.exportMarkdownZip}>Download Markdown ZIP</a>
        </div>
      </section>
      <section class="panel">
        <h2>Your feeds</h2>
        <p class="muted">New stories, delivered to your library.</p>
        <form
          class="save-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const feed = await api.addFeed(feedUrl);
              setFeeds((items) => [...items.filter((f) => f.id !== feed.id), feed]);
              setFeedUrl("");
            });
          }}
        >
          <label class="sr-only" for="feed-url">
            Feed URL
          </label>
          <input
            id="feed-url"
            required
            type="url"
            placeholder="https://example.com/feed.xml"
            value={feedUrl}
            onInput={(e) => setFeedUrl(e.currentTarget.value)}
          />
          <button disabled={busy}>Add feed</button>
        </form>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await api.refreshFeeds();
              setFeeds((await api.feeds()).items);
              setMessage(`${result.added} new articles added.`);
            })
          }
        >
          Refresh feeds
        </button>
        {!feeds.length && <p class="muted">No feeds yet.</p>}
        {feeds.map((feed) => (
          <div class="feed" key={feed.id}>
            <strong>{feed.title || feed.url}</strong>
            <small class="break">{feed.url}</small>
            {feed.lastError && <p role="status">{feed.lastError}</p>}
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.deleteFeed(feed.id);
                  setFeeds((items) => items.filter((f) => f.id !== feed.id));
                })
              }
            >
              Remove feed
            </button>
          </div>
        ))}
      </section>
    </section>
  );
}
