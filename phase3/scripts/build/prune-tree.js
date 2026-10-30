// build a pruned copy of /home/ghost from trace files: node prune.js <dest> <trace.json>...
const fs = require('fs');
const path = require('path');
const ROOT = '/home/ghost';
const [dest, ...traces] = process.argv.slice(2);
const files = new Set(); const dirs = new Set();
for (const t of traces) {
  const j = JSON.parse(fs.readFileSync(t));
  for (const f of [...j.req, ...j.read]) { try { const r = fs.realpathSync(f); if (fs.statSync(r).isFile()) files.add(r); } catch {} }
  for (const d of j.dirs) { try { const r = fs.realpathSync(d); if (fs.statSync(r).isDirectory()) { dirs.add(r);
    // a directory that was listed outside node_modules (migrations, locales...): keep its direct files
    if (r !== ROOT && !r.includes('/node_modules/')) for (const e of fs.readdirSync(r, { withFileTypes: true })) if (e.isFile()) files.add(path.join(r, e.name)); } } catch {} }
}
// package.json of every enclosing package
for (const f of [...files]) {
  let d = path.dirname(f);
  while (d.startsWith(ROOT) && d !== ROOT) {
    const pj = path.join(d, 'package.json');
    if (fs.existsSync(pj)) files.add(pj);
    if (path.basename(path.dirname(d)) === 'node_modules' || path.basename(d) === 'node_modules') break;
    d = path.dirname(d);
  }
}
fs.mkdirSync(dest, { recursive: true });
let bytes = 0;
for (const f of files) { const t = path.join(dest, path.relative(ROOT, f)); fs.mkdirSync(path.dirname(t), { recursive: true }); try { fs.copyFileSync(f, t); bytes += fs.statSync(f).size; } catch (e) { console.log('skip', f, e.code); } }
for (const d of dirs) fs.mkdirSync(path.join(dest, path.relative(ROOT, d)), { recursive: true });
// recreate every symlink under node_modules so package resolution works
let links = 0;
const walk = function walk(d, depth) {
  let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (e.isSymbolicLink()) {
      const t = path.join(dest, path.relative(ROOT, p));
      fs.mkdirSync(path.dirname(t), { recursive: true });
      try { fs.symlinkSync(fs.readlinkSync(p), t); links++; } catch {}
    } else if (e.isDirectory() && (e.name === 'node_modules' || e.name === '.pnpm' || e.name.startsWith('@') || path.basename(d) === '.pnpm')) {
      walk(p, depth + 1);
    }
  }
};
walk(path.join(ROOT, 'node_modules'), 1); if (fs.existsSync(path.join(ROOT, 'core/node_modules'))) walk(path.join(ROOT, 'core/node_modules'), 1);
console.log(`files ${files.size}, ${(bytes / 1e6).toFixed(1)} MB, dirs ${dirs.size}, symlinks ${links}`);
