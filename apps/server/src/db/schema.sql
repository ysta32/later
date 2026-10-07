-- FROZEN CONTRACT. node:sqlite (DatabaseSync). All timestamps ISO-8601 text.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,          -- scrypt$N$r$p$saltb64$hashb64
  created_at TEXT NOT NULL,
  inbound_token TEXT NOT NULL UNIQUE,
  kindle_email TEXT
);

CREATE TABLE IF NOT EXISTS sessions (     -- also API tokens (kind='api') for extension/bookmarklet/obsidian
  token_hash TEXT PRIMARY KEY,           -- sha256 hex of the bearer token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('session','api')),
  label TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT                        -- NULL = never (api tokens)
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT, site_name TEXT, excerpt TEXT,
  content_html TEXT NOT NULL DEFAULT '',
  text_content TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  lead_image TEXT, published_at TEXT,
  saved_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'inbox' CHECK (state IN ('inbox','archived')),
  favorite INTEGER NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  capture_status TEXT NOT NULL DEFAULT 'ok' CHECK (capture_status IN ('ok','pending','failed')),
  capture_error TEXT,
  summary TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS articles_user_url ON articles(user_id, url) WHERE url <> '';
CREATE INDEX IF NOT EXISTS articles_user_saved ON articles(user_id, saved_at DESC);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (article_id, tag)
);

CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quote TEXT NOT NULL, prefix TEXT NOT NULL DEFAULT '', suffix TEXT NOT NULL DEFAULT '',
  note TEXT, color TEXT NOT NULL DEFAULT 'yellow',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL, title TEXT NOT NULL,
  last_fetched_at TEXT, last_error TEXT,
  UNIQUE (user_id, url)
);
CREATE TABLE IF NOT EXISTS feed_seen (feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, guid TEXT NOT NULL, PRIMARY KEY (feed_id, guid));

-- Full-text search (external content over articles; kept in sync by triggers)
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(title, text_content, content='articles', content_rowid='rowid', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, text_content) VALUES (new.rowid, new.title, new.text_content); END;
CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, text_content) VALUES ('delete', old.rowid, old.title, old.text_content); END;
CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE OF title, text_content ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, text_content) VALUES ('delete', old.rowid, old.title, old.text_content);
  INSERT INTO articles_fts(rowid, title, text_content) VALUES (new.rowid, new.title, new.text_content); END;
