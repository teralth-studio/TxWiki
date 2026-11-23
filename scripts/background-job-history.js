'use strict';

async function ensureBackgroundJobHistory(pool, databaseType) {
  await pool.query(databaseType === 'sqlite'
    ? "CREATE TABLE IF NOT EXISTS background_job_history (id INTEGER PRIMARY KEY,status TEXT NOT NULL DEFAULT 'queued',category TEXT NOT NULL,action TEXT NOT NULL,error_code TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    : "CREATE TABLE IF NOT EXISTS background_job_history (id BIGINT UNSIGNED NOT NULL PRIMARY KEY,status ENUM('queued','running','success','error') NOT NULL DEFAULT 'queued',category VARCHAR(40) NOT NULL,action VARCHAR(120) NOT NULL,error_code VARCHAR(100) NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)");

  const indexes = databaseType === 'sqlite'
    ? [
        'CREATE INDEX IF NOT EXISTS idx_background_job_history_status_date ON background_job_history(status,created_at,id)',
        'CREATE INDEX IF NOT EXISTS idx_background_job_history_category_date ON background_job_history(category,created_at,id)',
      ]
    : [
        'CREATE INDEX idx_background_job_history_status_date ON background_job_history(status,created_at,id)',
        'CREATE INDEX idx_background_job_history_category_date ON background_job_history(category,created_at,id)',
      ];
  for (const statement of indexes) {
    try {
      await pool.query(statement);
    } catch (error) {
      if (databaseType !== 'mysql' || !['ER_DUP_KEYNAME', 'ER_DUP_FIELDNAME'].includes(error.code)) throw error;
    }
  }

  await pool.query(
    "INSERT IGNORE INTO background_job_history (id,status,category,action,error_code,created_at,updated_at) SELECT id,CASE status WHEN 'queued' THEN 'queued' WHEN 'processing' THEN 'running' WHEN 'done' THEN 'success' ELSE 'error' END,CASE job_type WHEN 'mail' THEN 'SMTP' WHEN 'backup' THEN 'Backups' ELSE 'System' END,CASE job_type WHEN 'mail' THEN 'Send email' WHEN 'backup' THEN 'Create backup' ELSE 'Execute system task' END,CASE WHEN status='failed' THEN 'JOB_FAILED' ELSE NULL END,created_at,COALESCE(completed_at,created_at) FROM background_jobs",
  );
}

module.exports = { ensureBackgroundJobHistory };
