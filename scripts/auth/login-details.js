const net = require('node:net');
const Bowser = require('bowser');

function loginDetails(req) {
  let address;
  try {
    address = req.ip;
  } catch (error) {
    console.warn('[Teralth Wiki] Login IP detection failed:', error.code || error.name || 'Error');
  }
  const ip = typeof address === 'string' && net.isIP(address) ? address : '127.0.0.1';
  if (ip !== address)
    console.warn('[Teralth Wiki] Could not determine the login IP; using 127.0.0.1.');
  const userAgent = req.get('user-agent');
  const parsed = typeof userAgent === 'string' && userAgent ? Bowser.parse(userAgent.slice(0, 2048)) : {};
  return {
    login_ip: ip,
    login_platform: parsed.browser?.name || 'Unknown',
    login_device: parsed.os?.name || 'Unknown',
    ip,
  };
}

module.exports = { loginDetails };
