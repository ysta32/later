import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api.ts";
import type { Article } from "../api.ts";
import { errorMessage, readingTime } from "../app.tsx";
import type { Route } from "../app.tsx";
import { cacheInbox, listOffline, queuePatch, replayOffline } from "../offline.ts";

type Item = Article & { snippet?: string };
export function Snippet({ text }: { text: string }) {
  // Treat all server text as text, recognizing only the search marker delimiters.
  return (
    <>
      {text
        .split(/(<mark>|<\/mark>)/g)
        .map((part, index, parts) =>
          part === "<mark>" || part === "</mark>" ? null : parts[index - 1] === "<mark>" ? (
            <mark key={index}>{part}</mark>
          ) : (
            part
          ),
        )}
    </>
  );
}
export default function Library({ route }: { route: Route }) {
  const [items, setItems] = useState<Item[]>([]);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  const generation = useRef(0);
  const pending = useRef(new Set<string>());
  const [working, setWorking] = useState<string[]>([]);
  const matches = (a: Article) =>
    route.page === "archive"
      ? a.state === "archived"
      : route.page === "favorites"
        ? a.favorite
        : route.page === "tag"
          ? a.tags.includes(route.value!)
          : route.page === "search"
            ? true
            : a.state === "inbox";
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  async function load(more = false) {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    if (!more) {
      setItems([]);
      setCursor(null);
    }
    try {
      const result =
        route.page === "search"
          ? search
            ? await api.search(search)
            : { items: [] }
          : await api.list({
              state: route.page === "archive" ? "archived" : route.page === "inbox" ? "inbox" : "all",
              favorite: route.page === "favorites" ? true : undefined,
              tag: route.page === "tag" ? route.value : undefined,
              limit: 30,
              cursor: more ? (cursor ?? undefined) : undefined,
            });
      if (generation.current !== request) return;
      setItems((previous) =>
        more
          ? [...previous, ...result.items.filter((item) => !previous.some((p) => p.id === item.id))]
          : result.items,
      );
      setCursor("nextCursor" in result ? result.nextCursor : null);
      setOffline(false);
    } catch (error) {
      if (generation.current !== request) return;
      if (error instanceof ApiError) setError(errorMessage(error));
      else {
        try {
          const cached = (await listOffline())
            .filter(matches)
            .filter(
              (a) => !search || `${a.title} ${a.textContent}`.toLowerCase().includes(search.toLowerCase()),
            );
          if (generation.current === request) {
            setItems(cached);
            setCursor(null);
            setOffline(true);
          }
        } catch (storageError) {
          setError(errorMessage(storageError));
        }
      }
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    const refresh = () => {
      void load();
    };
    window.addEventListener("later:sync", refresh);
    return () => {
      generation.current++;
      window.removeEventListener("later:sync", refresh);
    };
  }, [search]);
  useEffect(() => {
    void api
      .tags()
      .then((result) => setTags(result.tags))
      .catch(() => {
        void listOffline()
          .then((articles) => {
            const counts = new Map<string, number>();
            articles.forEach((a) => a.tags.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1)));
            setTags([...counts].map(([tag, count]) => ({ tag, count })));
          })
          .catch(() => undefined);
      });
  }, [items.length]);
  async function action(article: Article, kind: "archive" | "favorite" | "delete" | "retry") {
    if (pending.current.has(article.id)) return;
    pending.current.add(article.id);
    setWorking([...pending.current]);
    setError("");
    try {
      if (kind === "delete") {
        await api.remove(article.id);
        setItems((items) => items.filter((a) => a.id !== article.id));
      } else if (kind === "retry") {
        const updated = await api.refetch(article.id);
        setItems((items) => items.map((a) => (a.id === updated.id ? updated : a)));
      } else {
        const patch =
          kind === "favorite"
            ? { favorite: !article.favorite }
            : {
                state: article.state === "inbox" ? ("archived" as const) : ("inbox" as const),
              };
        let updated: Article;
        await queuePatch(article.id, patch);
        updated = { ...article, ...patch };
        try {
          await replayOffline();
        } catch (error) {
          if (error instanceof ApiError) throw error;
          setOffline(true);
        }
        setItems((items) => items.map((a) => (a.id === article.id ? updated : a)).filter(matches));
      }
      if (navigator.onLine) void cacheInbox().catch(() => undefined);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pending.current.delete(article.id);
      setWorking([...pending.current]);
    }
  }
  const title =
    route.page === "archive"
      ? "The archive"
      : route.page === "favorites"
        ? "Your favorites"
        : route.page === "tag"
          ? route.value
          : route.page === "search"
            ? "Find a little inspiration"
            : "Your reading, at your pace.";
  return (
    <section>
      <header>
        <p class="eyebrow">Your personal library</p>
        <h1>{title}</h1>
        <p class="muted">Good things are worth coming back to.</p>
      </header>
      <form
        class="save-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setError("");
          try {
            await api.save(url);
            setUrl("");
            await load();
            void cacheInbox().catch(() => undefined);
          } catch (error) {
            setError(errorMessage(error));
          } finally {
            setSaving(false);
          }
        }}
      >
        <label class="sr-only" for="save-url">
          Article URL
        </label>
        <input
          id="save-url"
          type="url"
          placeholder="Paste a link to save for later…"
          required
          value={url}
          onInput={(e) => setUrl(e.currentTarget.value)}
        />
        <button class="primary" disabled={saving}>
          {saving ? "Saving…" : "Save article"}
        </button>
      </form>
      {route.page === "search" && (
        <label>
          Search your library
          <input
            type="search"
            autoFocus
            placeholder="A word, an idea, a title…"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>
      )}
      {error && (
        <p role="alert" class="notice">
          {error}
        </p>
      )}
      {offline && <p class="notice">Showing downloaded articles. Changes will sync when you’re online.</p>}
      <div class="library-layout">
        <div aria-live="polite">
          {items.map((article) => (
            <article class="article-card" key={article.id}>
              <div class="article-meta">
                <span>{article.siteName ?? "From your library"}</span>
                <span>{readingTime(article.wordCount)} min read</span>
              </div>
              <h2>
                <a href={`#/read/${encodeURIComponent(article.id)}`}>
                  {article.title || article.url || "Untitled article"}
                </a>
              </h2>
              <p class="excerpt">{article.snippet ? <Snippet text={article.snippet} /> : article.excerpt}</p>
              <div class="tags">
                {article.tags.map((tag) => (
                  <a key={tag} href={`#/tag/${encodeURIComponent(tag)}`}>
                    {tag}
                  </a>
                ))}
              </div>
              {article.captureStatus !== "ok" && (
                <p class="capture">
                  {article.captureStatus === "failed"
                    ? "Capture failed — your link is saved."
                    : "Preparing your article…"}
                  {article.captureStatus === "failed" && (
                    <button
                      disabled={working.includes(article.id)}
                      onClick={() => void action(article, "retry")}
                    >
                      Retry
                    </button>
                  )}
                </p>
              )}
              <div class="article-actions">
                <button
                  disabled={working.includes(article.id)}
                  onClick={() => void action(article, "archive")}
                >
                  {article.state === "inbox" ? "Archive" : "Move to inbox"}
                </button>
                <button
                  aria-pressed={article.favorite}
                  disabled={working.includes(article.id)}
                  onClick={() => void action(article, "favorite")}
                >
                  {article.favorite ? "★ Favorited" : "☆ Favorite"}
                </button>
                <button
                  disabled={working.includes(article.id)}
                  onClick={() => {
                    if (confirm(`Delete “${article.title}”?`)) void action(article, "delete");
                  }}
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
          {busy && <p role="status">Gathering your reading…</p>}
          {!busy && !items.length && (
            <div class="empty">
              <span>✦</span>
              <h2>
                {route.page === "search" ? "What’s on your mind?" : "A little room for something good."}
              </h2>
              <p>
                {route.page === "search"
                  ? search
                    ? "No matching articles."
                    : "Search for something you remember reading."
                  : "Save a link above, or explore the rest of your library."}
              </p>
            </div>
          )}
          {cursor && (
            <button class="load-more" disabled={busy} onClick={() => void load(true)}>
              Load more
            </button>
          )}
        </div>
        <aside class="tag-sidebar">
          <h3>Browse by tag</h3>
          {tags.length ? (
            tags.map(({ tag, count }) => (
              <a key={tag} href={`#/tag/${encodeURIComponent(tag)}`}>
                {tag}
                <small>{count}</small>
              </a>
            ))
          ) : (
            <p class="muted">Your tags will appear here.</p>
          )}
        </aside>
      </div>
    </section>
  );
}
