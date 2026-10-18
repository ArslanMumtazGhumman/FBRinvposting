/**
 * Create the first tenant, owner and business (runs as the table owner):
 *   npm run seed -- owner@company.pk "Owner Name" "StrongPassword" 1234567 "Company (Pvt) Ltd"
 *   (or, from a build: node dist/seed.js ...)
 */
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { hashPassword, newTotpSecret } from './lib/auth.js';
import { businesses, memberships, tenants, users } from './db/schema.js';

const [email, name = '', password, ntn, bizName = ''] = process.argv.slice(2);
if (!email || !password || password.length < 12 || !/^(\d{7}|\d{13})$/.test(ntn ?? '')) {
  console.error('Usage: npm run seed -- <email> <name> <password 12+ chars> <ntn 7|13 digits> <business name>');
  process.exit(1);
}
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!ownerUrl) { console.error('Set MIGRATION_DATABASE_URL (table owner).'); process.exit(1); }

const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
const db = drizzle(sql);
try {
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.toLowerCase()));
  if (exists) { console.error('User exists'); process.exit(1); }
  const tenantId = 't_' + crypto.randomUUID();
  const userId = 'u_' + crypto.randomUUID();
  const bizId = 'b_' + crypto.randomUUID();
  const totpSecret = newTotpSecret();
  await db.transaction(async tx => {
    await tx.insert(tenants).values({ id: tenantId, name: bizName });
    await tx.insert(users).values({ id: userId, tenantId, email: email.toLowerCase(), name, role: 'owner', passwordHash: hashPassword(password), totpSecret });
    await tx.insert(businesses).values({ id: bizId, tenantId, name: bizName, ntnCnic: ntn!, province: 'Punjab', address: '', activity: 'Other', sector: 'All Other Sectors', environment: 'sandbox' });
    await tx.insert(memberships).values({ userId, businessId: bizId, role: 'owner' });
  });
  console.log(`Created owner ${email} and business ${bizName}.`);
  console.log(`Add this secret to an authenticator app (TOTP, 6 digits, 30 s): ${totpSecret}`);
  console.log(`otpauth://totp/Rasid:${encodeURIComponent(email)}?secret=${totpSecret}&issuer=Rasid`);
} finally {
  await sql.end();
}
