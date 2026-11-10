'use strict';

const AUDITABLE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUDIT_INSERT =
  'INSERT INTO admin_logs (actor_user_id,username,action_key,detail) VALUES (?,?,?,?)';

function cleanAuditDetail(value, maxLength = 180) {
  if (typeof value !== 'string') return '';
  let cleaned = '';
  let offset = 0;
  while (offset < value.length) {
    const opening = value.indexOf('<', offset);
    if (opening < 0) {
      cleaned += value.slice(offset);
      break;
    }
    const closing = value.indexOf('>', opening + 1);
    if (closing < 0) {
      cleaned += value.slice(offset);
      break;
    }
    cleaned += value.slice(offset, opening) + ' ';
    offset = closing + 1;
  }
  return cleaned
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function preferredLabel(values) {
  if (typeof values === 'string') return cleanAuditDetail(values);
  if (!values || typeof values !== 'object' || Array.isArray(values)) return '';
  for (const key of ['en', 'es', ...Object.keys(values)]) {
    if (typeof values[key] === 'string' && values[key].trim()) return cleanAuditDetail(values[key]);
  }
  return '';
}

function describeAdminAction(method, path, body = {}) {
  const pathname = String(path || '').split('?')[0].replace(/\/{2,}/g, '/');
  const normalizedMethod = String(method || '').toUpperCase();
  const segments = pathname.split('/').filter(Boolean);
  const action = (actionKey, detail = '') => ({ actionKey, detail: cleanAuditDetail(detail) });
  const singular = (name, verbs) => {
    const index = segments.indexOf(name);
    if (index < 0) return null;
    const hasId = segments.length > index + 1;
    const detail = hasId ? segments[index + 1] : preferredLabel(body?.titles || body?.names || body?.name);
    if (normalizedMethod === 'POST' && !hasId) return action(`${name}.created`, detail);
    if (normalizedMethod === 'PUT' || normalizedMethod === 'PATCH')
      return action(`${name}.updated`, detail);
    if (normalizedMethod === 'DELETE' && hasId) return action(`${name}.deleted`, detail);
    return action(verbs?.[normalizedMethod] || 'admin.change', detail);
  };

  if (pathname === '/api/admin/smtp/test') return action('smtp.tested');
  if (pathname === '/api/admin/settings/registration') return action('registration.updated');
  if (pathname === '/api/admin/backups/import') return action('backup.imported');
  if (pathname === '/api/admin/backups/create') return action('backup.created');
  if (pathname === '/api/admin/backups/schedule') return action('backup.schedule.updated');
  if (pathname === '/api/admin/themes/backup') return action('theme.backup.created');
  if (pathname === '/api/admin/themes/install') return action('theme.installed');
  if (pathname === '/api/admin/themes/active') return action('theme.activated', body?.slug);
  if (/^\/api\/admin\/themes\/[^/]+\/settings$/.test(pathname)) return action('theme.settings.updated', segments.at(-2));
  if (/^\/api\/admin\/themes\/[^/]+$/.test(pathname) && normalizedMethod === 'DELETE')
    return action('theme.deleted', segments.at(-1));
  if (pathname === '/api/admin/captcha') {
    if (body?.enabled === false) return action('captcha.disabled');
    if (body?.enabled === true) {
      const providerNames = {
        hcaptcha: 'hCaptcha',
        recaptcha: 'Google reCAPTCHA',
        'cloudflare-turnstile': 'Cloudflare Turnstile',
        turnstile: 'Cloudflare Turnstile',
      };
      return action('captcha.enabled', providerNames[String(body.provider || '').toLowerCase()] || 'CAPTCHA');
    }
    return action('captcha.updated');
  }
  if (pathname.startsWith('/api/admin/reverse-proxy')) return action('proxy.updated');
  if (pathname.startsWith('/api/admin/smtp')) return action('smtp.updated');
  if (pathname.startsWith('/api/admin/backups')) return action('backup.updated');
  if (pathname.startsWith('/api/admin/updates')) return action('update.installed');
  if (pathname === '/api/admin/home-page') return action('home.updated', cleanAuditDetail(body?.pageSlug));
  if (pathname === '/api/admin/navigation/order') return action('navigation.updated');
  if (pathname.startsWith('/api/admin/uploads')) return action('media.uploaded');
  if (/^\/api\/admin\/spaces\/[^/]+\/logo$/.test(pathname))
    return action('space.logo.updated', segments.at(-2));
  if (pathname === '/api/admin/settings') return action('site.settings.updated');
  if (pathname === '/api/admin/roles') return action('roles.updated');
  if (pathname === '/api/admin/header-links') return action('header-links.updated');
  if (pathname.startsWith('/api/admin/languages')) return action('languages.updated');
  if (pathname.startsWith('/api/admin/users')) {
    if (segments.at(-1) === 'reset-password') return action('user.password.reset', segments.at(-2));
    if (segments.at(-1) === 'role') return action('user.role.updated', segments.at(-2));
    if (normalizedMethod === 'DELETE') return action('user.deleted', segments.at(-1));
    return action('user.updated', segments.at(-1));
  }
  const pageAction = singular('pages', { POST: 'page.updated' });
  if (pageAction) return pageAction;
  const categoryAction = singular('categories');
  if (categoryAction) return categoryAction;
  const spaceAction = singular('spaces');
  if (spaceAction) return spaceAction;

  const safePath = pathname
    .replace(/\?.*$/, '')
    .replace(/\/(\d+)(?=\/|$)/g, '/:id')
    .slice(0, 140);
  return action('admin.change', `${normalizedMethod} ${safePath}`);
}

function createAdminAuditMiddleware(pool, { onError = console.error } = {}) {
  return function adminAuditMiddleware(req, res, next) {
    const method = String(req.method || '').toUpperCase();
    if (!AUDITABLE_METHODS.has(method) || !String(req.path || '').startsWith('/api/admin/')) return next();

    const actor = req.session?.user;
    const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor?.id) > 0 ? Number(actor.id) : null;
    const username = cleanAuditDetail(actor?.username || 'System', 60) || 'System';
    const { actionKey, detail } = describeAdminAction(method, req.path, req.body);
    const sendJson = res.json.bind(res);
    let auditAttempted = false;

    res.json = (payload) => {
      if (auditAttempted || res.statusCode < 200 || res.statusCode >= 300) return sendJson(payload);
      auditAttempted = true;
      Promise.resolve(pool.execute(AUDIT_INSERT, [actorId, username, actionKey, detail]))
        .then(() => sendJson(payload))
        .catch((error) => {
          const code = /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'AUDIT_WRITE_FAILED';
          onError('[Teralth Wiki] Admin audit event could not be stored', code);
          sendJson(payload);
        });
      return res;
    };
    next();
  };
}

module.exports = { AUDIT_INSERT, cleanAuditDetail, describeAdminAction, createAdminAuditMiddleware };
