import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "./api.ts";
import type { User } from "./api.ts";
import {
  cacheInbox,
  clearOffline,
  clearOtherOfflineUsers,
  getOfflineArticle,
  replayOffline,
  setOfflineUser,
} from "./offline.ts";
import Library from "./pages/Library.tsx";
import Settings from "./pages/Settings.tsx";
import Ask from "./pages/Ask.tsx";
import Highlights from "./pages/Highlights.tsx";
import Reader from "./reader/Reader.tsx";

export type Route = {
  page:
    | "inbox"
    | "archive"
    | "favorites"
    | "search"
    | "highlights"
    | "ask"
    | "settings"
    | "tag"
    | "read"
    | "saved";
  value?: string;
};
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "/";
  if (path === "/" || path === "") return { page: "inbox" };
  const match = /^\/(tag|read|saved)\/([^/]+)$/.exec(path);
  if (match) {
    try {
      return {
        page: match[1] as "tag" | "read" | "saved",
        value: decodeURIComponent(match[2]!),
      };
    } catch {
      return { page: "inbox" };
    }
  }
  const page = path.slice(1);
  if (["archive", "favorites", "search", "highlights", "ask", "settings"].includes(page))
    return { page: page as Route["page"] };
  return { page: "inbox" };
}
export function readingTime(wordCount: number): number {
  return Number.isFinite(wordCount) ? Math.max(1, Math.ceil(wordCount / 230)) : 1;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
function storedUser(): User | null {
  try {
    return JSON.parse(localStorage.getItem("later-user") ?? "null") as User | null;
  } catch {
    return null;
  }
}
function Auth({ onLogin }: { onLogin: (user: User) => Promise<void> }) {
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <main class="auth">
      <a class="brand" href="#/">
        Later<span>✦</span>
      </a>
      <h1>
        A little space
        <br />
        for a good read.
      </h1>
      <p class="muted">Save what matters. Come back when you have a moment.</p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onLogin((await (signup ? api.signup(email, password) : api.login(email, password))).user);
          } catch (error) {
            setError(errorMessage(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>{signup ? "Create your library" : "Welcome back"}</h2>
        <label>
          Email
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            minLength={signup ? 8 : undefined}
            autoComplete={signup ? "new-password" : "current-password"}
            value={password}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </label>
        <button class="primary" disabled={busy}>
          {busy ? "One moment…" : signup ? "Create account" : "Sign in"}
        </button>
        <p role="alert">{error}</p>
      </form>
      <button
        class="text-button"
        onClick={() => {
          setSignup(!signup);
          setError("");
        }}
      >
        {signup ? "Already have an account? Sign in" : "New here? Create an account"}
      </button>
    </main>
  );
}
export default function App() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [theme, setTheme] = useState(() => localStorage.getItem("later-theme") ?? "system");
  const acceptUser = async (value: User) => {
    try {
      await clearOtherOfflineUsers(value.id);
    } catch (error) {
      setError(errorMessage(error));
      return;
    }
    localStorage.setItem("later-user", JSON.stringify(value));
    setOfflineUser(value.id);
    setUser(value);
  };
  useEffect(() => {
    const change = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", change);
    void api
      .me()
      .then(({ user }) => acceptUser(user))
      .catch(async (error) => {
        if (!(error instanceof ApiError)) {
          const cached = storedUser();
          if (cached) await acceptUser(cached);
        } else if (error.status === 401) {
          const cached = storedUser();
          localStorage.removeItem("later-user");
          setOfflineUser(null);
          if (cached) {
            try {
              await clearOffline(cached.id);
            } catch (error) {
              setError(errorMessage(error));
            }
          }
        } else setError(errorMessage(error));
      })
      .finally(() => setLoading(false));
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("later-theme", theme);
  }, [theme]);
  useEffect(() => {
    const sync = () => {
      setOnline(navigator.onLine);
      if (user && navigator.onLine)
        void cacheInbox()
          .then(() => window.dispatchEvent(new Event("later:sync")))
          .catch((error) => setError(`Offline sync: ${errorMessage(error)}`));
    };
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, [user?.id]);
  if (loading)
    return (
      <main class="auth">
        <p role="status">Opening your library…</p>
      </main>
    );
  if (!user)
    return (
      <>
        <Auth onLogin={acceptUser} />
        {error && <p role="alert">{error}</p>}
      </>
    );
  const navigation = [
    ["/", "Inbox", "inbox"],
    ["/archive", "Archive", "archive"],
    ["/favorites", "Favorites", "favorites"],
    ["/search", "Search", "search"],
    ["/highlights", "Highlights", "highlights"],
    ["/ask", "Ask your library", "ask"],
    ["/settings", "Settings", "settings"],
  ];
  return (
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" href="#/">
          Later<span>✦</span>
        </a>
        <p class="eyebrow">A place for your curiosity</p>
        <nav aria-label="Main navigation">
          {navigation.map(([href, title, page]) => (
            <a key={href} href={`#${href}`} aria-current={route.page === page ? "page" : undefined}>
              {title}
            </a>
          ))}
        </nav>
        <div class="sidebar-bottom">
          <label>
            Appearance
            <select value={theme} onChange={(e) => setTheme(e.currentTarget.value)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <small>{user.email}</small>
          <button
            class="text-button"
            onClick={async () => {
              try {
                await replayOffline().catch(() => undefined);
                await api.logout();
                try {
                  await clearOffline(user.id);
                } finally {
                  localStorage.removeItem("later-user");
                  setOfflineUser(null);
                  setUser(null);
                  location.hash = "/";
                }
              } catch (error) {
                setError(errorMessage(error));
              }
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main class="content">
        {!online && (
          <p class="notice" role="status">
            You’re offline. Your downloaded reading and queued changes are safe here.
          </p>
        )}
        {error && (
          <p class="notice" role="alert">
            {error} <button onClick={() => setError("")}>Dismiss</button>
          </p>
        )}
        {route.page === "settings" ? (
          <Settings user={user} onUser={acceptUser} />
        ) : route.page === "ask" ? (
          <Ask />
        ) : route.page === "highlights" ? (
          <Highlights />
        ) : route.page === "read" ? (
          <Reader
            id={route.value!}
            loadOffline={(id: string) => getOfflineArticle(id).then((article) => article ?? null)}
            onClose={() => {
              location.hash = "/";
            }}
          />
        ) : route.page === "saved" ? (
          <section>
            <p class="eyebrow">Safely tucked away</p>
            <h1>Saved for later.</h1>
            <p>Your article is in your library.</p>
            <a class="button primary" href={`#/read/${encodeURIComponent(route.value!)}`}>
              Read now
            </a>{" "}
            <a href="#/">Back to library</a>
          </section>
        ) : (
          <Library key={`${route.page}:${route.value ?? ""}`} route={route} />
        )}
      </main>
    </div>
  );
}
