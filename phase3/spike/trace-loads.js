// preload: record every file the process requires or reads under /home/ghost
const fs = require('fs');
const path = require('path');
const ROOT = '/home/ghost';
const read = new Set();
const dirs = new Set();
const note = (p, set) => { try { if (typeof p === 'string' || Buffer.isBuffer(p)) { const a = path.resolve(String(p)); if (a.startsWith(ROOT)) set.add(a); } } catch {} };
for (const fn of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'createReadStream', 'realpathSync', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'readlinkSync', 'opendirSync']) {
  const o = fs[fn]; if (!o) continue;
  fs[fn] = function (p, ...r) { note(p, read); return o.call(this, p, ...r); };
}
for (const fn of ['readdirSync']) { const o = fs[fn]; fs[fn] = function (p, ...r) { note(p, dirs); return o.call(this, p, ...r); }; }
const oo = fs.promises.readFile; fs.promises.readFile = function (p, ...r) { note(p, read); return oo.call(this, p, ...r); };
const od = fs.promises.readdir; fs.promises.readdir = function (p, ...r) { note(p, dirs); return od.call(this, p, ...r); };
const orf = fs.readFile; fs.readFile = function (p, ...r) { note(p, read); return orf.call(this, p, ...r); };
process.on('exit', () => {
  const req = Object.keys(require.cache).filter((f) => f.startsWith(ROOT));
  fs.writeFileSync(process.env.TRACE_OUT, JSON.stringify({ req, read: [...read], dirs: [...dirs] }));
});
