// Runs ON THE INSTANCE (shipped there base64-encoded by
// ssm-backup-instance.sh --vacuum-db). Takes a clean, single-file snapshot
// of a live Ghost SQLite database using VACUUM INTO, then proves the result
// is sound before anything downstream trusts it.
//
// Why not the sqlite3 CLI: it is not installed on the appserver and this is
// a production instance, so installing a package to take a backup is a
// worse trade than using the better-sqlite3 already vendored inside Ghost's
// own node_modules. Node and that module are both present by definition —
// Ghost cannot run without them.
//
// Usage: node remote-vacuum.js <ghost-node-modules-dir> <source.db> <target.db>
'use strict';

const [, , modulesDir, sourcePath, targetPath] = process.argv;
if (!modulesDir || !sourcePath || !targetPath) {
  console.error('usage: remote-vacuum.js <ghost-node-modules-dir> <source.db> <target.db>');
  process.exit(1);
}

const Database = require(`${modulesDir}/better-sqlite3`);

// Read-only on the source: VACUUM INTO writes a new file and never modifies
// the database it reads, and opening read-only makes that guarantee
// enforced rather than merely intended.
const source = new Database(sourcePath, { readonly: true });
try {
  // The target must not exist — VACUUM INTO refuses to overwrite, which is
  // the behaviour we want, so surface it rather than clearing the path.
  source.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
} finally {
  source.close();
}

// Prove the snapshot is sound. integrity_check returns rows rather than
// signalling through an exit code, so the result has to be read: a corrupt
// database reports its problems here and still "succeeds" as a query.
const snapshot = new Database(targetPath, { readonly: true });
try {
  const rows = snapshot.pragma('integrity_check');
  const verdict = rows.map((row) => row.integrity_check).join('; ');
  if (verdict !== 'ok') {
    console.error(`integrity_check failed: ${verdict}`);
    process.exit(1);
  }
  const { n } = snapshot.prepare('SELECT COUNT(*) AS n FROM posts').get();
  console.log(`snapshot ok: integrity_check=ok, posts=${n}`);
} finally {
  snapshot.close();
}
