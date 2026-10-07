import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { api, links, ApiError } from "../api.ts";
import type { Article, Highlight } from "../api.ts";
import { cssVars, loadSettings, saveSettings, SIZE_RANGE, LINE_HEIGHT_RANGE } from "./typography.ts";
import type { TypographySettings } from "./typography.ts";
import { applyHighlights, removeHighlight, selectionAnchor } from "./highlight.ts";
import type { HighlightColor } from "./highlight.ts";
import { createTts, speakableBlocks, ttsSupported } from "./tts.ts";
import type { TtsController, TtsState } from "./tts.ts";
import { createProgressTracker, scrollFraction, sendProgressKeepalive } from "./progress.ts";
import "./reader.css";

interface Props {
  id: string;
  onClose: () => void;
  loadOffline?: (id: string) => Promise<Article | null>;
}

const COLORS: HighlightColor[] = ["yellow", "green", "blue", "pink"];
const readingMinutes = (words: number) => Math.max(1, Math.round(words / 230));
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

export default function Reader({ id, onClose, loadOffline }: Props) {
  const [article, setArticle] = useState<Article | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<TypographySettings>(() => loadSettings());
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [panel, setPanel] = useState<null | "type" | "tags" | "notes" | "listen" | "summary">(null);
  const [barHidden, setBarHidden] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sel, setSel] = useState<{
    x: number;
    y: number;
    quote: string;
    prefix: string;
    suffix: string;
  } | null>(null);
  const [editing, setEditing] = useState<{ h: Highlight; x: number; y: number } | null>(null);
  const [summary, setSummary] = useState<{ text: string; method: string } | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [tagText, setTagText] = useState("");
  const [tts, setTts] = useState<TtsState>("idle");
  const [rate, setRate] = useState(1);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const ttsRef = useRef<TtsController | null>(null);
  const lastScroll = useRef(0);
  const lastFraction = useRef(0);
  const activeId = useRef(id);
  const blocksRef = useRef<{ el: Element; text: string }[]>([]);
  const [voiceUri, setVoiceUri] = useState<string | null>(null);
  const [noting, setNoting] = useState(false);
  const [noteText, setNoteText] = useState("");
  const trackerRef = useRef<ReturnType<typeof createProgressTracker> | null>(null);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast((t) => (t === m ? null : t)), 3200);
  };

  // load article (network, falling back to offline cache)
  useEffect(() => {
    let live = true;
    activeId.current = id;
    setArticle(null);
    setError(null);
    setHighlights([]);
    setSummary(null);
    setSummaryBusy(false);
    setPanel(null);
    setSel(null);
    setEditing(null);
    setNoting(false);
    ttsRef.current?.stop();
    ttsRef.current = null;
    (async () => {
      try {
        const a = await api.get(id);
        if (live) {
          setArticle(a);
          setTagText(a.tags.join(", "));
        }
      } catch (e) {
        const off = loadOffline ? await loadOffline(id).catch(() => null) : null;
        if (!live) return;
        if (off) {
          setArticle(off);
          setTagText(off.tags.join(", "));
        } else setError(errMsg(e));
      }
    })();
    api
      .highlights(id)
      .then((r) => live && setHighlights(r.items))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);

  // typography persistence
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // render content once, then anchor highlights
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !article) return;
    body.innerHTML = article.contentHtml;
    applyHighlights(
      body,
      highlights.map((h) => ({
        id: h.id,
        quote: h.quote,
        prefix: h.prefix,
        suffix: h.suffix,
        color: h.color,
        note: h.note,
      })),
    );
  }, [article, highlights]);

  // restore scroll once per article; re-apply while content grows (images) until the user scrolls
  useEffect(() => {
    const el = scrollRef.current;
    const body = bodyRef.current;
    if (!el || !article) return;
    let userMoved = false;
    lastFraction.current = article.progress;
    const restore = () => {
      if (userMoved || article.progress <= 0) return;
      el.scrollTop = article.progress * (el.scrollHeight - el.clientHeight);
    };
    const moved = () => {
      userMoved = true;
    };
    const userEvents = ["wheel", "touchstart", "pointerdown", "keydown"];
    for (const ev of userEvents) el.addEventListener(ev, moved, { passive: true });
    const t = requestAnimationFrame(restore);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(restore) : null;
    if (body) ro?.observe(body);
    body?.addEventListener("load", restore, true);
    const persist = (f: number) => {
      api.update(id, { progress: f }).catch(() => {});
    };
    const tracker = createProgressTracker(persist, article.progress);
    trackerRef.current = tracker;
    // always compare against the last persisted value, not the value at open
    const unload = () => tracker.sendNow(lastFraction.current, (f) => sendProgressKeepalive(id, f));
    window.addEventListener("pagehide", unload);
    return () => {
      cancelAnimationFrame(t);
      ro?.disconnect();
      body?.removeEventListener("load", restore, true);
      for (const ev of userEvents) el.removeEventListener(ev, moved);
      window.removeEventListener("pagehide", unload);
      tracker.sendNow(lastFraction.current, persist);
      tracker.dispose();
    };
  }, [article?.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    lastFraction.current = scrollFraction(el);
    trackerRef.current?.update(lastFraction.current);
    const y = el.scrollTop;
    if (Math.abs(y - lastScroll.current) > 8) setBarHidden(y > lastScroll.current && y > 120);
    lastScroll.current = y;
    if (!noting) setSel(null);
  };

  // text selection -> floating menu
  const onMouseUp = () => {
    setTimeout(() => {
      const s = window.getSelection();
      const body = bodyRef.current;
      if (!s || s.isCollapsed || !body || s.rangeCount === 0) return;
      const r = s.getRangeAt(0);
      if (!body.contains(r.commonAncestorContainer)) return;
      const a = selectionAnchor(body, r);
      if (!a) return;
      const rect = r.getBoundingClientRect();
      setSel({ x: rect.left + rect.width / 2, y: rect.top, ...a });
    }, 0);
  };

  const addHighlight = async (color: HighlightColor, note: string | null) => {
    if (!sel) return;
    const { quote, prefix, suffix } = sel;
    const forId = id;
    setSel(null);
    setNoting(false);
    setNoteText("");
    window.getSelection()?.removeAllRanges();
    try {
      const h = await api.addHighlight(forId, { quote, prefix, suffix, color, note: note?.trim() || null });
      if (activeId.current === forId) setHighlights((hs) => [...hs, h]);
    } catch (e) {
      flash(errMsg(e));
    }
  };

  const onBodyClick = (e: MouseEvent) => {
    const m = (e.target as HTMLElement).closest?.("mark[data-hid]");
    if (!m) {
      setEditing(null);
      return;
    }
    const h = highlights.find((x) => x.id === m.getAttribute("data-hid"));
    if (h) {
      const r = m.getBoundingClientRect();
      setEditing({ h, x: r.left + r.width / 2, y: r.bottom });
    }
  };

  const patchHighlight = async (h: Highlight, p: { note?: string | null; color?: HighlightColor }) => {
    try {
      const u = await api.updateHighlight(h.id, p);
      setHighlights((hs) => hs.map((x) => (x.id === u.id ? u : x)));
      setEditing(null);
    } catch (e) {
      flash(errMsg(e));
    }
  };
  const deleteHighlight = async (h: Highlight) => {
    try {
      await api.deleteHighlight(h.id);
      if (bodyRef.current) removeHighlight(bodyRef.current, h.id);
      setHighlights((hs) => hs.filter((x) => x.id !== h.id));
      setEditing(null);
    } catch (e) {
      flash(errMsg(e));
    }
  };

  // article actions
  const patchArticle = async (p: Parameters<typeof api.update>[1]) => {
    try {
      setArticle(await api.update(id, p));
    } catch (e) {
      flash(errMsg(e));
    }
  };
  const archive = async () => {
    if (!article) return;
    await patchArticle({ state: article.state === "archived" ? "inbox" : "archived" });
    flash(article.state === "archived" ? "Moved to inbox" : "Archived");
  };
  const saveTags = async () => {
    await patchArticle({
      tags: tagText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
    setPanel(null);
  };
  const kindle = async () => {
    try {
      await api.sendToKindle(id);
      flash("Sent to Kindle");
    } catch (e) {
      flash(
        e instanceof ApiError && e.status === 501
          ? "Kindle email isn't set up. Configure SMTP on the server."
          : errMsg(e),
      );
    }
  };
  const summarize = async () => {
    setPanel("summary");
    if (summary) return;
    if (article?.summary) {
      setSummary({ text: article.summary, method: "saved" });
      return;
    }
    const forId = id;
    setSummaryBusy(true);
    try {
      const r = await api.summarize(forId);
      if (activeId.current === forId) setSummary({ text: r.summary, method: r.method });
    } catch (e) {
      if (activeId.current === forId) {
        flash(errMsg(e));
        setPanel(null);
      }
    } finally {
      if (activeId.current === forId) setSummaryBusy(false);
    }
  };

  // TTS
  const markCurrent = (i: number) => {
    bodyRef.current?.querySelectorAll(".tts-current").forEach((n) => n.classList.remove("tts-current"));
    const p = blocksRef.current[i]?.el as HTMLElement | undefined;
    if (p) {
      p.classList.add("tts-current");
      p.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };
  const startTts = () => {
    if (ttsRef.current) {
      ttsRef.current.state === "paused" ? ttsRef.current.resume() : ttsRef.current.play();
      return;
    }
    blocksRef.current = bodyRef.current ? speakableBlocks(bodyRef.current) : [];
    const c = createTts({
      chunks: blocksRef.current.map((b) => b.text),
      onChunk: markCurrent,
      onState: (s) => {
        setTts(s);
        if (s === "idle")
          bodyRef.current?.querySelectorAll(".tts-current").forEach((n) => n.classList.remove("tts-current"));
      },
    });
    ttsRef.current = c;
    c.setRate(rate);
    c.setVoice(voiceUri);
    c.play();
  };
  const stopTts = () => {
    ttsRef.current?.stop();
    ttsRef.current = null;
  };
  useEffect(() => {
    if (!ttsSupported()) return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => {
      speechSynthesis.removeEventListener?.("voiceschanged", load);
      ttsRef.current?.stop();
    };
  }, []);

  // keyboard
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.matches?.("input, textarea, select")) return;
      if (e.key === "Escape") {
        if (panel || sel || editing) {
          setPanel(null);
          setSel(null);
          setEditing(null);
        } else onClose();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [panel, sel, editing]);

  const style = useMemo(() => cssVars(settings) as unknown as string, [settings]);
  const set = <K extends keyof TypographySettings>(k: K, v: TypographySettings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }));

  if (error)
    return (
      <div class="reader" data-theme={settings.theme}>
        <div class="r-empty">
          <p>{error}</p>
          <button class="r-btn" onClick={onClose}>
            Back
          </button>
        </div>
      </div>
    );
  if (!article)
    return (
      <div class="reader" data-theme={settings.theme}>
        <div class="r-empty r-pulse">Opening…</div>
      </div>
    );

  const pending = article.captureStatus !== "ok" && !article.contentHtml;

  return (
    <div class="reader" data-theme={settings.theme} style={style}>
      <header class={"r-bar" + (barHidden ? " hidden" : "")}>
        <button class="r-btn" onClick={onClose} aria-label="Back">
          ←
        </button>
        <span class="r-spacer" />
        <button
          class={"r-btn" + (article.favorite ? " on" : "")}
          onClick={() => patchArticle({ favorite: !article.favorite })}
          aria-pressed={article.favorite}
          title="Favorite"
        >
          {article.favorite ? "★" : "☆"}
        </button>
        <button
          class="r-btn"
          onClick={archive}
          title={article.state === "archived" ? "Move to inbox" : "Archive"}
        >
          {article.state === "archived" ? "Unarchive" : "Archive"}
        </button>
        <button
          class={"r-btn" + (panel === "tags" ? " on" : "")}
          onClick={() => setPanel(panel === "tags" ? null : "tags")}
        >
          Tags
        </button>
        <button
          class={"r-btn" + (panel === "type" ? " on" : "")}
          onClick={() => setPanel(panel === "type" ? null : "type")}
          aria-label="Typography"
        >
          Aa
        </button>
        {ttsSupported() && (
          <button
            class={"r-btn" + (panel === "listen" || tts !== "idle" ? " on" : "")}
            onClick={() => setPanel(panel === "listen" ? null : "listen")}
          >
            Listen
          </button>
        )}
        <button class={"r-btn" + (panel === "summary" ? " on" : "")} onClick={summarize}>
          Summary
        </button>
        <button
          class={"r-btn" + (panel === "notes" ? " on" : "")}
          onClick={() => setPanel(panel === "notes" ? null : "notes")}
        >
          Notes{highlights.length ? ` ${highlights.length}` : ""}
        </button>
        <a class="r-btn" href={links.epub(id)} download>
          EPUB
        </a>
        <button class="r-btn" onClick={kindle}>
          Kindle
        </button>
      </header>

      {panel === "type" && (
        <div class="r-pop" role="dialog" aria-label="Typography">
          <Seg
            label="Theme"
            value={settings.theme}
            opts={[
              ["light", "Light"],
              ["sepia", "Sepia"],
              ["dark", "Dark"],
            ]}
            on={(v) => set("theme", v)}
          />
          <Seg
            label="Font"
            value={settings.font}
            opts={[
              ["serif", "Serif"],
              ["sans", "Sans"],
              ["dyslexia", "Easy read"],
            ]}
            on={(v) => set("font", v)}
          />
          <Seg
            label="Width"
            value={settings.width}
            opts={[
              ["narrow", "Narrow"],
              ["medium", "Medium"],
              ["wide", "Wide"],
            ]}
            on={(v) => set("width", v)}
          />
          <label class="r-row">
            <span>Size {settings.size}</span>
            <input
              type="range"
              min={SIZE_RANGE[0]}
              max={SIZE_RANGE[1]}
              step="1"
              value={settings.size}
              onInput={(e) => set("size", Number(e.currentTarget.value))}
            />
          </label>
          <label class="r-row">
            <span>Spacing {settings.lineHeight.toFixed(1)}</span>
            <input
              type="range"
              min={LINE_HEIGHT_RANGE[0]}
              max={LINE_HEIGHT_RANGE[1]}
              step="0.1"
              value={settings.lineHeight}
              onInput={(e) => set("lineHeight", Number(e.currentTarget.value))}
            />
          </label>
        </div>
      )}
      {panel === "tags" && (
        <div class="r-pop" role="dialog" aria-label="Tags">
          <label class="r-row col">
            <span>Tags, comma separated</span>
            <input
              class="r-input"
              value={tagText}
              onInput={(e) => setTagText(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && saveTags()}
              autofocus
            />
          </label>
          <button class="r-btn solid" onClick={saveTags}>
            Save
          </button>
        </div>
      )}
      {panel === "listen" && (
        <div class="r-pop" role="dialog" aria-label="Listen">
          <div class="r-row">
            <button
              class="r-btn solid"
              onClick={tts === "playing" ? () => ttsRef.current?.pause() : startTts}
            >
              {tts === "playing" ? "Pause" : tts === "paused" ? "Resume" : "Play"}
            </button>
            <button class="r-btn" onClick={stopTts} disabled={tts === "idle"}>
              Stop
            </button>
          </div>
          <label class="r-row">
            <span>Speed {rate.toFixed(1)}×</span>
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={rate}
              onInput={(e) => {
                const r = Number(e.currentTarget.value);
                setRate(r);
                ttsRef.current?.setRate(r);
              }}
            />
          </label>
          {voices.length > 0 && (
            <label class="r-row col">
              <span>Voice</span>
              <select
                class="r-input"
                value={voiceUri ?? ""}
                onChange={(e) => {
                  const v = e.currentTarget.value || null;
                  setVoiceUri(v);
                  ttsRef.current?.setVoice(v);
                }}
              >
                <option value="">Default</option>
                {voices.map((v) => (
                  <option value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {panel === "summary" && (
        <div class="r-pop wide" role="dialog" aria-label="Summary">
          {summaryBusy ? (
            <p class="r-pulse">Summarizing…</p>
          ) : (
            summary && (
              <>
                <p class="r-summary">{summary.text}</p>
                <p class="r-meta">
                  {summary.method === "claude"
                    ? "Summarized by Claude"
                    : summary.method === "extractive"
                      ? "Key sentences, extracted"
                      : "Saved summary"}
                </p>
              </>
            )
          )}
        </div>
      )}

      <div class="r-scroll" ref={scrollRef} onScroll={onScroll} onMouseUp={onMouseUp}>
        <article class="r-article">
          <header class="r-head">
            <h1>{article.title}</h1>
            <p class="r-meta">
              {[
                article.siteName || host(article.url),
                article.author,
                `${readingMinutes(article.wordCount)} min read`,
              ]
                .filter(Boolean)
                .join(" · ")}
              {article.url && (
                <>
                  {" "}
                  ·{" "}
                  <a href={article.url} target="_blank" rel="noopener noreferrer">
                    Original ↗
                  </a>
                </>
              )}
            </p>
          </header>
          {pending && (
            <p class="r-notice">
              {article.captureStatus === "pending"
                ? "Still fetching this page…"
                : `Couldn't capture this page${article.captureError ? `: ${article.captureError}` : "."}`}
            </p>
          )}
          <div class="r-body" ref={bodyRef} onClick={onBodyClick} />
          <div class="r-end">· · ·</div>
        </article>
      </div>

      {panel === "notes" && (
        <aside class="r-side" aria-label="Notes">
          <h2>Highlights</h2>
          {highlights.length === 0 && <p class="r-meta">Select text to highlight it.</p>}
          {highlights.map((h) => (
            <div class="r-note" data-color={h.color} key={h.id}>
              <button
                class="r-quote"
                onClick={() =>
                  bodyRef.current
                    ?.querySelector(`mark[data-hid="${h.id}"]`)
                    ?.scrollIntoView({ block: "center", behavior: "smooth" })
                }
              >
                {h.quote}
              </button>
              {h.note && <p>{h.note}</p>}
            </div>
          ))}
        </aside>
      )}

      {sel && (
        <div
          class={"r-float" + (noting ? " below" : "")}
          style={{ left: sel.x, top: sel.y }}
          onMouseDown={(e) => {
            if (!noting) e.preventDefault();
          }}
        >
          {noting ? (
            <>
              <textarea
                class="r-input"
                rows={3}
                placeholder="Add a note"
                autofocus
                value={noteText}
                onInput={(e) => setNoteText(e.currentTarget.value)}
              />
              <div class="r-row">
                <button class="r-btn solid" onClick={() => addHighlight("yellow", noteText)}>
                  Save
                </button>
                <button
                  class="r-btn"
                  onClick={() => {
                    setNoting(false);
                    setNoteText("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              {COLORS.map((c) => (
                <button
                  class="r-dot"
                  data-color={c}
                  aria-label={`Highlight ${c}`}
                  onClick={() => addHighlight(c, null)}
                />
              ))}
              <button class="r-btn" onClick={() => setNoting(true)}>
                Note
              </button>
            </>
          )}
        </div>
      )}
      {editing && (
        <div class="r-float below" style={{ left: editing.x, top: editing.y }}>
          <div class="r-row">
            {COLORS.map((c) => (
              <button
                class={"r-dot" + (editing.h.color === c ? " on" : "")}
                data-color={c}
                aria-label={c}
                onClick={() => patchHighlight(editing.h, { color: c })}
              />
            ))}
          </div>
          <textarea
            class="r-input"
            rows={2}
            placeholder="Add a note"
            defaultValue={editing.h.note ?? ""}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim() || null;
              if (v !== editing.h.note) patchHighlight(editing.h, { note: v });
            }}
          />
          <button class="r-btn danger" onClick={() => deleteHighlight(editing.h)}>
            Delete
          </button>
        </div>
      )}
      {toast && (
        <div class="r-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function Seg<T extends string>(p: { label: string; value: T; opts: [T, string][]; on: (v: T) => void }) {
  return (
    <div class="r-row col">
      <span>{p.label}</span>
      <div class="r-seg" role="group" aria-label={p.label}>
        {p.opts.map(([v, l]) => (
          <button class={p.value === v ? "on" : ""} aria-pressed={p.value === v} onClick={() => p.on(v)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}
