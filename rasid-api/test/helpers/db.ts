/**
 * Starts PostgreSQL 16 in a container, applies migrations and points
 * DATABASE_URL (API role, RLS enforced) / MIGRATION_DATABASE_URL (owner) at it.
 * Call before importing anything from src/ that reads config.
 */
import crypto from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { runMigrations } from '../../src/db/migrate.js';
import * as schema from '../../src/db/schema.js';

export interface TestDb {
  container: StartedPostgreSqlContainer;
  ownerUrl: string;
  appUrl: string;
  /** Owner connection: bypasses RLS, for fixtures and assertions. */
  admin: ReturnType<typeof drizzle<typeof schema>>;
  adminSql: postgres.Sql;
  stop(): Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('rasid').withUsername('rasid_owner').withPassword('owner-pw').start();
  const ownerUrl = container.getConnectionUri();
  const app = new URL(ownerUrl);
  app.username = 'rasid_api';
  app.password = 'api-pw';
  const appUrl = app.toString();
  await runMigrations(ownerUrl, appUrl);

  process.env.DATABASE_URL = appUrl;
  process.env.MIGRATION_DATABASE_URL = ownerUrl;
  process.env.SESSION_SECRET ??= 'test-secret-' + crypto.randomUUID();
  process.env.VAULT_KEY_V1 ??= crypto.randomBytes(32).toString('base64');

  const adminSql = postgres(ownerUrl, { max: 2, onnotice: () => {} });
  return {
    container, ownerUrl, appUrl, adminSql, admin: drizzle(adminSql, { schema }),
    async stop() { await adminSql.end(); await container.stop(); },
  };
}
