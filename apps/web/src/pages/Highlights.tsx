import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { errorMessage } from "../app.tsx";
export default function Highlights() {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.allHighlights>>["items"]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true;
    void api
      .allHighlights()
      .then((result) => {
        if (active) setItems(result.items);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <section class="narrow">
      <p class="eyebrow">Words worth keeping</p>
      <h1>Your highlights</h1>
      <p class="muted">The passages that stayed with you.</p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Loading highlights…</p>}
      {!busy && !error && !items.length && (
        <div class="empty">
          <h2>Keep a thought for later.</h2>
          <p>Highlight a passage while reading to collect it here.</p>
        </div>
      )}
      {items.map((item) => (
        <article class="panel highlight" key={item.id} data-color={item.color}>
          <blockquote>{item.quote}</blockquote>
          {item.note && <p>{item.note}</p>}
          <a href={`#/read/${encodeURIComponent(item.articleId)}`}>{item.articleTitle || "Read article"}</a>
          <small>{new Date(item.createdAt).toLocaleDateString()}</small>
        </article>
      ))}
    </section>
  );
}
