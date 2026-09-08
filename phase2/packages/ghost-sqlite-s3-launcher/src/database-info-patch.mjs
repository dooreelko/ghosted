import fs from 'node:fs';
import path from 'node:path';

/**
 * Every installed copy of @tryghost/database-info under <nodeModulesRoot>/.pnpm
 * (a pnpm virtual store can hold multiple resolved versions at once). Returns
 * absolute paths to each version's index.js. Empty array if .pnpm is absent.
 */
export function findDatabaseInfoPaths(nodeModulesRoot) {
  const pnpmDir = path.join(nodeModulesRoot, 'node_modules', '.pnpm');
  let entries;
  try {
    entries = fs.readdirSync(pnpmDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith('@tryghost+database-info@'))
    .map((entry) => path.join(pnpmDir, entry, 'node_modules', '@tryghost', 'database-info', 'index.js'));
}

/**
 * Ghost's ecosystem does string-based client-type detection in several places
 * (Ghost core's connection.js, knex-migrator's database.js, and
 * @tryghost/database-info) that a class-valued Knex `client` fails, since they
 * check `config.client === 'better-sqlite3'` rather than duck-typing. Patch this
 * one installed copy of database-info so it recognizes SqliteS3Client too.
 */
export function patchDatabaseInfoAt(absolutePath, SqliteS3Client, requireFn) {
  const DatabaseInfo = requireFn(absolutePath);
  const origIsSQLite = DatabaseInfo.isSQLite;
  const origIsSQLiteConfig = DatabaseInfo.isSQLiteConfig;
  DatabaseInfo.isSQLite = (knex) =>
    knex.client.config.client === SqliteS3Client || origIsSQLite.call(DatabaseInfo, knex);
  DatabaseInfo.isSQLiteConfig = (config) =>
    config.client === SqliteS3Client || origIsSQLiteConfig.call(DatabaseInfo, config);
}
