PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  is_primary_admin INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  previous_password_hash TEXT,
  temporary_password_expires_at TEXT,
  two_factor_secret TEXT,
  two_factor_recovery_codes TEXT,
  two_factor_last_step INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_temporary_expiration ON users(must_change_password,temporary_password_expires_at);

CREATE TABLE IF NOT EXISTS spaces (
  slug TEXT NOT NULL PRIMARY KEY COLLATE BINARY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'fa-book-open',
  logo TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  home_page_slug TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_slug TEXT NOT NULL COLLATE BINARY,
  parent_id INTEGER,
  icon TEXT NOT NULL DEFAULT 'fa-file-lines',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_open INTEGER NOT NULL DEFAULT 1,
  names TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (space_slug) REFERENCES spaces(slug) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_categories_space_order ON categories(space_slug,sort_order,id);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_slug TEXT NOT NULL COLLATE BINARY,
  category_id INTEGER,
  slug TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'fa-file-lines',
  page_type TEXT NOT NULL DEFAULT 'content' CHECK(page_type IN ('content','redirect')),
  redirect_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  titles TEXT NOT NULL DEFAULT '{}',
  content TEXT NOT NULL DEFAULT '{}',
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(space_slug,slug),
  FOREIGN KEY (space_slug) REFERENCES spaces(slug) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_space_navigation ON pages(space_slug,category_id,sort_order,slug);

CREATE TABLE IF NOT EXISTS settings (
  setting_key TEXT NOT NULL PRIMARY KEY,
  setting_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_slug TEXT NOT NULL COLLATE BINARY,
  page_id INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  user_id INTEGER,
  mood TEXT NOT NULL CHECK(mood IN ('happy','neutral','sad')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(page_id,ip_hash),
  FOREIGN KEY (space_slug) REFERENCES spaces(slug) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_reactions_page_mood ON reactions(page_id,mood);
CREATE INDEX IF NOT EXISTS idx_reactions_page_user ON reactions(page_id,user_id);
CREATE INDEX IF NOT EXISTS idx_reactions_space_page_mood ON reactions(space_slug,page_id,mood,user_id,ip_hash);

CREATE TABLE IF NOT EXISTS account_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_token_user_purpose ON account_tokens(user_id,purpose);
CREATE INDEX IF NOT EXISTS idx_token_expiration ON account_tokens(purpose,expires_at,used_at);

CREATE TABLE IF NOT EXISTS roles (
  role_key TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#64748b',
  permissions TEXT NOT NULL DEFAULT '[]',
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS background_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TEXT,
  lock_token TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_background_jobs_claim ON background_jobs(status,available_at,id);
CREATE INDEX IF NOT EXISTS idx_background_jobs_expiry ON background_jobs(status,locked_until,id);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT NOT NULL PRIMARY KEY,
  total_hits INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_reset ON rate_limit_buckets(reset_at);

CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_user_id INTEGER,
  username TEXT NOT NULL,
  action_key TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_admin_logs_date ON admin_logs(occurred_at,id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_user_date ON admin_logs(username,occurred_at,id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_action_date ON admin_logs(action_key,occurred_at,id);

CREATE TABLE IF NOT EXISTS wiki_updates (
  update_id TEXT NOT NULL PRIMARY KEY,
  release_version TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wiki_update_migrations (
  migration_id TEXT NOT NULL PRIMARY KEY,
  update_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
