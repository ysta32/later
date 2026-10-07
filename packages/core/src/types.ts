// FROZEN CONTRACT. Change only via a DECISION in .orch/DECISIONS.md.

export type ArticleState = "inbox" | "archived";
export type CaptureSource =
  | "server"      // server-side fetch + readability
  | "extension"   // rendered DOM from the user's browser session
  | "bookmarklet"
  | "share"       // PWA share target
  | "email"       // email-in address
  | "rss"         // feed / newsletter
  | "import"
  | "api";

export interface Article {
  id: string;            // ulid-ish, from newId()
  userId: string;
  url: string;           // canonical URL ("" allowed for email newsletters)
  title: string;
  author: string | null;
  siteName: string | null;
  excerpt: string | null;
  contentHtml: string;   // sanitized readable HTML ("" if capture pending/failed)
  textContent: string;   // plain text for search/TTS/AI
  wordCount: number;
  leadImage: string | null;
  publishedAt: string | null; // ISO
  savedAt: string;       // ISO
  updatedAt: string;     // ISO
  state: ArticleState;
  favorite: boolean;
  progress: number;      // 0..1 scroll progress
  source: CaptureSource;
  captureStatus: "ok" | "pending" | "failed";
  captureError: string | null;
  tags: string[];
  summary: string | null; // AI or extractive summary
}

export interface Highlight {
  id: string;
  articleId: string;
  userId: string;
  quote: string;         // exact selected text
  prefix: string;        // up to 32 chars before (for re-anchoring)
  suffix: string;        // up to 32 chars after
  note: string | null;
  color: "yellow" | "green" | "blue" | "pink";
  createdAt: string;
  updatedAt: string;
}

export interface Feed {
  id: string;
  userId: string;
  url: string;
  title: string;
  lastFetchedAt: string | null;
  lastError: string | null;
}

export interface User {
  id: string;
  email: string;
  createdAt: string;
  inboundToken: string;  // email-in local part: save+<token>@<domain>
  kindleEmail: string | null;
}

/** Output of every extractor (server readability, extension DOM, email body). */
export interface Extracted {
  url: string;
  title: string;
  author: string | null;
  siteName: string | null;
  excerpt: string | null;
  contentHtml: string;   // sanitized
  textContent: string;
  wordCount: number;
  leadImage: string | null;
  publishedAt: string | null;
}

/** Normalized record produced by every importer (Pocket/Omnivore/Instapaper/Readwise/bookmarks). */
export interface ImportItem {
  url: string;
  title: string | null;
  tags: string[];
  savedAt: string | null;     // ISO
  state: ArticleState;
  favorite: boolean;
  highlights: { quote: string; note: string | null; createdAt: string | null }[];
  contentHtml?: string | null; // when the export includes content (Omnivore/Readwise)
}

export type ImportFormat = "pocket" | "omnivore" | "instapaper" | "readwise" | "bookmarks";

/** Full export bundle (JSON export; also the schema for backup/restore). */
export interface ExportBundle {
  version: 1;
  exportedAt: string;
  articles: Article[];
  highlights: Highlight[];
  feeds: Feed[];
}
