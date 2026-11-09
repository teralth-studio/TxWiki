'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { parseUpdatePublicKey, sshPublicKeyBlob, verifyUpdatePackage } = require('./site-updater');

async function main() {
  const packagePath = process.argv[2];
  if (!packagePath) throw new Error('Usage: node scripts/verify-update-package.js <update.zip>');
  const trustedKey = process.env.UPDATE_PUBLIC_KEY || require('./update-public-key');
  const publicKey = parseUpdatePublicKey(trustedKey);
  const result = await verifyUpdatePackage(path.resolve(packagePath), trustedKey);
  const publicBlob = sshPublicKeyBlob(publicKey);
  const fingerprint = crypto.createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '');
  console.log(`Package signature and all declared hashes are valid.`);
  console.log(`Update: ${result.id} (${result.version})`);
  console.log(`Fresh-install files: ${result.installation.length}`);
  console.log(`Trusted signer: ${publicKey.asymmetricKeyType} SHA256:${fingerprint}`);
}

if (require.main === module)
  main().catch((error) => {
    console.error(`Update package verification failed: ${error.message}`);
    process.exitCode = 1;
  });

module.exports = { main };
