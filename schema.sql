CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  username VARCHAR(60) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(64) NOT NULL DEFAULT 'user',
  is_primary_admin BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at DATETIME NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  previous_password_hash VARCHAR(255) NULL,
  temporary_password_expires_at DATETIME NULL,
  two_factor_secret TEXT NULL,
  two_factor_recovery_codes JSON NULL,
  two_factor_last_step BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_users_temporary_expiration (must_change_password,temporary_password_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS spaces (
  slug VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  icon VARCHAR(80) NOT NULL DEFAULT 'fa-book-open',
  logo VARCHAR(500) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  home_page_slug VARCHAR(150) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  space_slug VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  parent_id BIGINT UNSIGNED NULL,
  icon VARCHAR(80) NOT NULL DEFAULT 'fa-file-lines',
  sort_order INT NOT NULL DEFAULT 0,
  is_open BOOLEAN NOT NULL DEFAULT TRUE,
  names JSON NOT NULL,
  KEY idx_categories_space_order (space_slug, sort_order, id),
  FOREIGN KEY (space_slug) REFERENCES spaces(slug) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS pages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  space_slug VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  category_id BIGINT UNSIGNED NULL,
  slug VARCHAR(150) NOT NULL,
  icon VARCHAR(80) NOT NULL DEFAULT 'fa-file-lines',
  page_type ENUM('content','redirect') NOT NULL DEFAULT 'content',
  redirect_url VARCHAR(2048) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  titles JSON NOT NULL,
  content JSON NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_page_space_slug (space_slug, slug),
  KEY idx_pages_space_navigation (space_slug, category_id, sort_order, slug),
  FOREIGN KEY (space_slug) REFERENCES spaces(slug) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
  setting_value JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS reactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  space_slug VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  page_id BIGINT UNSIGNED NOT NULL,
  ip_hash CHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  mood ENUM('happy','neutral','sad') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reaction_ip_page (page_id, ip_hash),
  KEY idx_reactions_page_mood (page_id, mood),
  KEY idx_reactions_page_user (page_id, user_id),
  FOREIGN KEY (space_slug) REFERENCES spaces(slug) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS account_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  purpose ENUM('verify','reset') NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_token_user_purpose (user_id, purpose),
  INDEX idx_token_expiration (purpose, expires_at, used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS roles (
  role_key VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  color CHAR(7) NOT NULL DEFAULT '#64748b',
  permissions JSON NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS background_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_type VARCHAR(32) NOT NULL,
  dedupe_key VARCHAR(191) NULL UNIQUE,
  payload MEDIUMTEXT NULL,
  status ENUM('queued','processing','done','failed') NOT NULL DEFAULT 'queued',
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until DATETIME NULL,
  lock_token CHAR(36) NULL,
  last_error VARCHAR(120) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  KEY idx_background_jobs_claim (status, available_at, id),
  KEY idx_background_jobs_expiry (status, locked_until, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key CHAR(64) NOT NULL PRIMARY KEY,
  total_hits INT UNSIGNED NOT NULL,
  reset_at BIGINT UNSIGNED NOT NULL,
  KEY idx_rate_limit_reset (reset_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS admin_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_user_id BIGINT UNSIGNED NULL,
  username VARCHAR(60) NOT NULL,
  action_key VARCHAR(80) NOT NULL,
  detail VARCHAR(180) NOT NULL DEFAULT '',
  KEY idx_admin_logs_date (occurred_at,id),
  KEY idx_admin_logs_user_date (username,occurred_at,id),
  KEY idx_admin_logs_action_date (action_key,occurred_at,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
