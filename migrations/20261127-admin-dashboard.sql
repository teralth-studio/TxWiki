CREATE TABLE IF NOT EXISTS dashboard_visitors (
  visit_day CHAR(10) NOT NULL,
  visitor_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (visit_day, visitor_hash)
);

CREATE INDEX idx_dashboard_visitors_day ON dashboard_visitors(visit_day);

CREATE TABLE IF NOT EXISTS dashboard_stats (
  snapshot_day CHAR(10) NOT NULL PRIMARY KEY,
  visitor_count INT NOT NULL DEFAULT 0,
  users_count BIGINT NOT NULL DEFAULT 0,
  pages_count BIGINT NOT NULL DEFAULT 0,
  happy_count BIGINT NOT NULL DEFAULT 0,
  neutral_count BIGINT NOT NULL DEFAULT 0,
  sad_count BIGINT NOT NULL DEFAULT 0,
  captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
