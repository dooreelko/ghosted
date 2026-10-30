// esbuild driver: bundle an entry, pin each module's __dirname/__filename to its original path
const esbuild = require('/tmp/esb/node_modules/esbuild');
const fs = require('fs');
const [entry, out, minify] = process.argv.slice(2);
const pinDirs = {
  name: 'pin-dirname',
  setup(b) {
    b.onLoad({ filter: /\.(c|m)?js$/ }, (args) => {
      const src = fs.readFileSync(args.path, 'utf8');
      if (!/__dirname|__filename/.test(src)) return null;
      const dir = args.path.replace(/\/[^/]*$/, '');
      const pre = `var __dirname=${JSON.stringify(dir)},__filename=${JSON.stringify(args.path)};\n`;
      return { contents: pre + src, loader: 'js' };
    });
  },
};
esbuild.build({
  entryPoints: [entry], bundle: true, platform: 'node', target: 'node22', outfile: out,
  minify: minify === 'min', keepNames: true, plugins: [pinDirs], logLevel: 'error', logLimit: 0,
  external: ['better-sqlite3', 'sqlite3', 'sharp', 'pg', 'pg-query-stream', 'mysql', 'mysql2', 'tedious', 'oracledb', 'pg-native', 're2', 'dtrace-provider'],
  alias: { 'jsonc-parser': require('child_process').execSync('ls -d /home/ghost/node_modules/.pnpm/jsonc-parser@*/node_modules/jsonc-parser/lib/esm/main.js').toString().trim() },
}).catch(() => process.exit(1));
