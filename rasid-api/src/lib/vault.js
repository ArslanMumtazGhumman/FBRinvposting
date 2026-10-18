/**
 * Token vault: AES-256-GCM with a random 96-bit IV per secret and the
 * business id as additional authenticated data (a ciphertext copied to
 * another business fails to decrypt). Key versions allow rotation:
 * add VAULT_KEY_V2, set VAULT_ACTIVE_KEY=v2, and old rows still decrypt.
 * In production the key comes from KMS/Vault (envelope encryption).
 */
import crypto from 'node:crypto';
import { config } from '../config.js';

export function encrypt(plaintext, aad) {
  const version = config.vaultActiveKey;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.vaultKeys[version], iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { version, data: Buffer.concat([iv, tag, ct]).toString('base64') };
}

export function decrypt(sealed, aad) {
  const key = config.vaultKeys[sealed.version];
  if (!key) throw new Error(`Unknown vault key version ${sealed.version}`);
  const buf = Buffer.from(sealed.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export const hint = (token) => '••••' + token.slice(-4);
