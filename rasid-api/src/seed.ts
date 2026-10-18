/**
 * Create the first owner and business:
 *   npm run seed -- owner@company.pk "Owner Name" "StrongPassword" 1234567 "Company (Pvt) Ltd"
 *   (or, from a build: node dist/seed.js ...)
 */
import crypto from 'node:crypto';
import { hashPassword, newTotpSecret } from './lib/auth.js';
import { insert, find } from './lib/db.js';

const [email, name = '', password, ntn, bizName = ''] = process.argv.slice(2);
if (!email || !password || password.length < 12 || !/^(\d{7}|\d{13})$/.test(ntn ?? '')) {
  console.error('Usage: npm run seed -- <email> <name> <password 12+ chars> <ntn 7|13 digits> <business name>');
  process.exit(1);
}
if (find('users', u => u.email === email.toLowerCase())) { console.error('User exists'); process.exit(1); }
const userId = 'u_' + crypto.randomUUID();
const bizId = 'b_' + crypto.randomUUID();
const totpSecret = newTotpSecret();
insert('users', { id: userId, email: email.toLowerCase(), name, role: 'owner', passwordHash: hashPassword(password), totpSecret, createdAt: new Date().toISOString() });
insert('businesses', { id: bizId, name: bizName, ntnCnic: ntn!, province: 'Punjab', address: '', activity: 'Other', sector: 'All Other Sectors', environment: 'sandbox' });
insert('memberships', { userId, businessId: bizId, role: 'owner' });
console.log(`Created owner ${email} and business ${bizName}.`);
console.log(`Add this secret to an authenticator app (TOTP, 6 digits, 30 s): ${totpSecret}`);
console.log(`otpauth://totp/Rasid:${encodeURIComponent(email)}?secret=${totpSecret}&issuer=Rasid`);
