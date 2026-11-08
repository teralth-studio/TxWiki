'use strict';

async function migrateSitePermissions(pool) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      "INSERT IGNORE INTO settings (setting_key,setting_value) VALUES ('migration_site_permissions_v1', JSON_OBJECT())",
    );
    if (result.affectedRows) {
      for (const permission of ['settings.support', 'settings.seo']) {
        await connection.query(
          "UPDATE roles SET permissions=JSON_ARRAY_APPEND(permissions, '$', ?) WHERE is_system=FALSE AND JSON_CONTAINS(permissions, JSON_QUOTE('settings.identity')) AND NOT JSON_CONTAINS(permissions, JSON_QUOTE(?))",
          [permission, permission],
        );
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { migrateSitePermissions };
