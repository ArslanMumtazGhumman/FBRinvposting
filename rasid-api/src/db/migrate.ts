/**
 * Applies drizzle/ migrations as the table owner (MIGRATION_DATABASE_URL),
 * then makes sure the API login role from DATABASE_URL exists and is a member
 * of rasid_app. An existing role's password is left alone.
 *
 *   npm run db:migrate
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export async function runMigrations(ownerUrl: string, appUrl?: string) {
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
    if (appUrl) await ensureAppLogin(sql, ownerUrl, appUrl);
  } finally {
    await sql.end();
  }
}

async function ensureAppLogin(sql: postgres.Sql, ownerUrl: string, appUrl: string) {
  const app = new URL(appUrl);
  const user = decodeURIComponent(app.username);
  if (user === decodeURIComponent(new URL(ownerUrl).username)) {
    throw new Error('DATABASE_URL must use a different role than MIGRATION_DATABASE_URL, or row-level security is bypassed.');
  }
  if (!IDENT.test(user)) throw new Error(`Unsupported role name in DATABASE_URL: ${user}`);
  const [exists] = await sql`select 1 from pg_roles where rolname = ${user}`;
  if (!exists) {
    const password = decodeURIComponent(app.password);
    if (!password) throw new Error('DATABASE_URL needs a password to create the API role.');
    // Utility statements cannot take bind parameters; the name is validated above, the password is quoted.
    await sql.unsafe(`CREATE ROLE "${user}" LOGIN PASSWORD '${password.replace(/'/g, "''")}' IN ROLE rasid_app`);
  } else {
    await sql.unsafe(`GRANT rasid_app TO "${user}"`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appUrl = process.env.DATABASE_URL;
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl || !appUrl) {
    console.error('Set MIGRATION_DATABASE_URL (table owner) and DATABASE_URL (API role).');
    process.exit(1);
  }
  runMigrations(ownerUrl, appUrl)
    .then(() => console.log('Migrations applied.'))
    .catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
