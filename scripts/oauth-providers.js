const crypto = require('node:crypto');
const providers = Object.freeze({
  google: { name: 'Google', authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', user: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email profile', pkce: true },
  discord: { name: 'Discord', authorize: 'https://discord.com/oauth2/authorize', token: 'https://discord.com/api/oauth2/token', user: 'https://discord.com/api/users/@me', scope: 'identify email', pkce: false },
  github: { name: 'GitHub', authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', user: 'https://api.github.com/user', scope: 'read:user user:email', pkce: true },
});
function createSecretStore(secret) {
  const key = crypto.createHash('sha256').update('txwiki-oauth-v1:').update(secret).digest();
  return {
    encrypt(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), encrypted].map(buffer => buffer.toString('base64url')).join('.');
    },
    decrypt(value) {
      const parts = String(value).split('.');
      if (parts.length !== 3) throw new Error('OAUTH_SECRET_INVALID');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'));
      decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}
function validateConnection(body, origin, existingSecret) {
  const provider = String(body.provider || ''), clientId = String(body.clientId || '').trim(), secret = String(body.clientSecret || '');
  if (!Object.hasOwn(providers, provider) || !clientId || clientId.length > 255 || /[\x00-\x20\x7f]/.test(clientId) || secret.length > 4096)
    throw Object.assign(new Error('Check the provider, Client ID and Client Secret.'), { status: 400 });
  const expected = new URL(`/auth/oauth/${provider}/callback`, origin);
  let redirect;
  try { redirect = new URL(String(body.redirectUri || expected.href)); }
  catch { throw Object.assign(new Error('Enter a valid callback URL.'), { status: 400 }); }
  if (redirect.href !== expected.href || (redirect.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)))
    throw Object.assign(new Error('Redirect URI must match the callback URL shown for this site.'), { status: 400 });
  if (!secret && !existingSecret) throw Object.assign(new Error('Client Secret is required.'), { status: 400 });
  return { provider, clientId, secret, redirectUri: redirect.href };
}
async function providerIdentity(provider, connection, code, verifier, secret, fetcher = fetch) {
  const config = providers[provider];
  const params = new URLSearchParams({ grant_type: 'authorization_code', client_id: connection.client_id, client_secret: secret, code, redirect_uri: connection.redirect_uri });
  if (config.pkce) params.set('code_verifier', verifier);
  const request = async (url, options) => {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('OAUTH_PROVIDER_REJECTED');
    return response.json();
  };
  const tokens = await request(config.token, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length > 8192) throw new Error('OAUTH_TOKEN_INVALID');
  const identity = await request(config.user, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json', 'User-Agent': 'TxWiki' } });
  const subject = String(provider === 'google' ? identity.sub || '' : identity.id || '');
  if (!/^[a-zA-Z0-9_-]{1,255}$/.test(subject)) throw new Error('OAUTH_IDENTITY_INVALID');
  return { subject, displayName: String(identity.name || identity.global_name || identity.login || identity.username || subject).slice(0, 255) };
}
module.exports = { providers, createSecretStore, validateConnection, providerIdentity };
