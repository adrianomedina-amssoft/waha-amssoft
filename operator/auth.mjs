import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

export async function openAuth({ filename, origin, secret, bootstrap = false }) {
  if (secret.length < 32) throw new Error('Authentication secret is too short');
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const database = new Database(filename);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  const auth = betterAuth({
    appName: 'AMS SOFT Status', baseURL: origin, basePath: '/auth', secret: secret,
    database: database, trustedOrigins: [origin], telemetry: { enabled: false },
    emailAndPassword: { enabled: true, disableSignUp: !bootstrap, requireEmailVerification: false },
    session: {
      expiresIn: 3600, updateAge: 300, cookieCache: { enabled: false },
      additionalFields: { operatorMfa: { type: 'boolean', defaultValue: false, input: false } },
    },
    advanced: { useSecureCookies: origin.startsWith('https:'), defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' } },
    rateLimit: { enabled: true, window: 60, max: 30, storage: 'database' },
    databaseHooks: {
      session: { create: { before: async (session, context) => ({
        data: { ...session, operatorMfa: context?.path === '/two-factor/verify-totp' },
      }) } },
    },
    plugins: [twoFactor({ issuer: 'AMS SOFT Status', skipVerificationOnEnable: false })],
  });
  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  return { auth, database };
}

export function operatorAllowed(session, administratorId) {
  return !!administratorId && session?.user?.id === administratorId &&
    session.user.twoFactorEnabled === true && session.session.operatorMfa === true;
}
