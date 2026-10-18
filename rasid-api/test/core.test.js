import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SESSION_SECRET = 'test-secret-' + crypto.randomUUID();
process.env.VAULT_KEY_V1 = crypto.randomBytes(32).toString('base64');
process.env.DATA_DIR = '/tmp/rasid-test-' + crypto.randomUUID();

const { encrypt, decrypt } = await import('../src/lib/vault.js');
const { audit, verifyChain } = await import('../src/lib/audit.js');
const { all } = await import('../src/lib/db.js');
const { hashPassword, verifyPassword } = await import('../src/lib/auth.js');

test('vault round-trips and binds ciphertext to its business', () => {
  const sealed = encrypt('secret-token-value-123', 'b1:sandbox');
  assert.equal(decrypt(sealed, 'b1:sandbox'), 'secret-token-value-123');
  assert.throws(() => decrypt(sealed, 'b2:sandbox'));
});

test('audit chain detects tampering', () => {
  audit({ actor: 'u1', action: 'a' }); audit({ actor: 'u1', action: 'b' });
  assert.equal(verifyChain(), true);
  all('audit')[0].action = 'changed';
  assert.equal(verifyChain(), false);
});

test('password hashing', () => {
  const h = hashPassword('correct horse battery');
  assert.equal(verifyPassword('correct horse battery', h), true);
  assert.equal(verifyPassword('wrong', h), false);
});
