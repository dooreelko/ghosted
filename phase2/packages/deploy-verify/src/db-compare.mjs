import { createHash } from 'node:crypto';

/**
 * What Ghost is permitted to change between the source snapshot and the
 * post-boot database. Anything outside this list failing the comparison is
 * the entire point: it turns "what legitimately changes on boot" into a
 * reviewable statement rather than a judgement call made under pressure.
 *
 * Both sides run the same Ghost version by construction (the EC2 instance is
 * upgraded to the target version before its database is taken), so no schema
 * migration runs on first boot and any structural difference is a real fault.
 *
 * `settingsKeys` starts empty ON PURPOSE. Populate it from an OBSERVED boot,
 * never by guessing: run the comparison once, read the reported `setting`
 * differences, satisfy yourself each one is Ghost rewriting its own
 * bookkeeping, and only then add its key here with a note saying why.
 */
export const BOOT_MUTATION_ALLOWLIST = {
  tables: [
    'sessions', // login sessions; the deploy-verify integration creates one
    'jobs', // scheduled-job bookkeeping, rewritten on boot
    'actions', // the audit log, which records the boot itself
    'brute', // rate-limiter counters
    'integrations', // the deploy-verify integration is deliberately added
    'api_keys', // ...and its key
  ],
  settingsKeys: [],
};

/**
 * The tables whose contents are compared, not merely counted: the ones a
 * reader of the blog would notice being wrong. `settings` is deliberately not
 * here — it is compared key-by-key against allowlist.settingsKeys below,
 * which is finer-grained than a whole-table checksum.
 */
export const CONTENT_TABLES = [
  'posts',
  'posts_meta',
  'users',
  'roles',
  'tags',
  'posts_tags',
  'members',
  'newsletters',
];

function userTables(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name);
}

export function tableRowCounts(db) {
  const counts = {};
  for (const table of userTables(db)) {
    // The table name comes from sqlite_master, never from user input. SQLite
    // does not allow a bound identifier, so interpolation is the only option
    // here; quoting it keeps unusual-but-legal table names working.
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  }
  return counts;
}

/**
 * An order-independent digest of a whole table: each row is serialised with
 * its column names, the rows are sorted, then hashed. Physical row order is a
 * detail a base-segment round-trip has no obligation to preserve, so an
 * ordering difference must not read as a content difference.
 */
export function contentChecksum(db, table) {
  const rows = db.prepare(`SELECT * FROM "${table}"`).all();
  const serialised = rows
    .map((row) =>
      Object.keys(row)
        .sort()
        .map((key) => `${key}=${row[key] === null ? '<null>' : String(row[key])}`)
        .join('|')
    )
    .sort();

  const hash = createHash('sha256');
  for (const line of serialised) {
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function settingsMap(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function compareDatabases({ source, target, allowlist = BOOT_MUTATION_ALLOWLIST }) {
  const differences = [];
  const allowedTables = new Set(allowlist.tables);
  const allowedSettings = new Set(allowlist.settingsKeys);

  const sourceTables = new Set(userTables(source));
  const targetTables = new Set(userTables(target));

  for (const name of sourceTables) {
    if (!targetTables.has(name)) {
      differences.push({ kind: 'table-set', name, detail: 'present in source, missing in target' });
    }
  }
  for (const name of targetTables) {
    if (!sourceTables.has(name)) {
      differences.push({ kind: 'table-set', name, detail: 'present in target, missing in source' });
    }
  }

  const sourceCounts = tableRowCounts(source);
  const targetCounts = tableRowCounts(target);
  for (const name of sourceTables) {
    if (!targetTables.has(name) || allowedTables.has(name)) continue;
    if (sourceCounts[name] !== targetCounts[name]) {
      differences.push({
        kind: 'row-count',
        name,
        detail: `source ${sourceCounts[name]}, target ${targetCounts[name]}`,
      });
    }
  }

  for (const name of CONTENT_TABLES) {
    if (!sourceTables.has(name) || !targetTables.has(name) || allowedTables.has(name)) continue;
    const a = contentChecksum(source, name);
    const b = contentChecksum(target, name);
    if (a !== b) {
      differences.push({
        kind: 'checksum',
        name,
        detail: `source ${a.slice(0, 12)}, target ${b.slice(0, 12)}`,
      });
    }
  }

  if (sourceTables.has('settings') && targetTables.has('settings')) {
    const a = settingsMap(source);
    const b = settingsMap(target);
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (allowedSettings.has(key)) continue;
      if (a[key] !== b[key]) {
        differences.push({ kind: 'setting', name: key, detail: `source ${a[key]}, target ${b[key]}` });
      }
    }
  }

  return { ok: differences.length === 0, differences };
}
