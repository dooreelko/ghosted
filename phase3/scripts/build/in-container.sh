#!/bin/sh
# Runs inside the Ghost image (as root, network on). Inputs mounted: /src (phase3/packages, ro),
# /build (this dir, ro), /out (output, rw). Env: ARCH=arm64|x64.
set -eu
ARCH="${ARCH:-arm64}"
# npm 11 skips dependency install scripts unless approved; better-sqlite3 needs its binary download
ALLOW="allow-scripts=better-sqlite3"
echo "== lambda dependencies ($ARCH)"
cp -r /src /tmp/work
rm -rf /tmp/work/*/node_modules   # a host install (seed script) must not mask the target install
for d in /tmp/work/*; do echo "$ALLOW" > $d/.npmrc; done
for d in sqlite-s3 ghost-lambda; do
  cd /tmp/work/$d
  if [ "$ARCH" = arm64 ]; then
    npm_config_arch=arm64 npm_config_platform=linux npm_config_target_arch=arm64 npm_config_target_platform=linux \
      npm install --omit=dev --no-audit --no-fund --os=linux --cpu=arm64 2>&1 | tail -4
  else
    npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1
  fi
done

echo "== Ghost tree natives for Node $(node -v) (x64, so the trace can run here)"
ABI=$(node -p process.versions.modules)
mkdir -p /tmp/x64g && cd /tmp/x64g && npm init -y >/dev/null && echo "$ALLOW" > .npmrc
npm install --no-audit --no-fund better-sqlite3@12.11.1 2>&1 | tail -1
find /home/ghost/node_modules -name better_sqlite3.node -exec cp /tmp/x64g/node_modules/better-sqlite3/build/Release/better_sqlite3.node {} \;
node -e "
  const fs=require('fs'),z=require('zlib');
  (async()=>{
    const r=await fetch('https://github.com/uhop/node-re2/releases/download/1.26.1/linux-x64-$ABI.br');
    if(!r.ok) throw new Error('re2 x64 download '+r.status);
    fs.writeFileSync('/tmp/re2-x64.node', z.brotliDecompressSync(Buffer.from(await r.arrayBuffer())));
  })().catch(e=>{console.error(e);process.exit(1)});"
find /home/ghost/node_modules -name re2.node -exec cp /tmp/re2-x64.node {} \;

echo "== trace the entries on the full tree (x64, runs here)"
cd /home/ghost
export NODE_ENV=production url=http://localhost:2368/blog database__client=better-sqlite3 database__connection__filename=/tmp/g.db logging__level=error
GHOST_CI_SHUTDOWN_AFTER_BOOT=1 node index.js >/dev/null 2>&1 || true   # only needed to create the migrated database
mkdir -p /tmp/lam /tmp/tr
# the lambda test needs x64 natives under its own node_modules; the arm64 copy is not runnable here
if [ "$ARCH" = arm64 ]; then
  cp -r /src /tmp/trace-work
  rm -rf /tmp/trace-work/*/node_modules
  for d in /tmp/trace-work/*; do echo "$ALLOW" > $d/.npmrc; done
  for d in sqlite-s3 ghost-lambda; do (cd /tmp/trace-work/$d && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1); done
  TRACE_WORK=/tmp/trace-work
else
  TRACE_WORK=/tmp/work
fi
unset database__client database__connection__filename
export GHOST_ROOT=/home/ghost SEED_DB=/tmp/g.db GHOST_URL=http://localhost:2368/blog DATA_DIR=/tmp/lam
export NODE_OPTIONS="-r /build/trace-loads.js"
for t in members-session.local.mjs write-path.local.mjs; do
  (cd $TRACE_WORK/ghost-lambda && TRACE_OUT=/tmp/tr/$t-%p.json node test/$t > /tmp/trace-$t.log 2>&1) || { echo "trace run failed: $t" >&2; tail -20 /tmp/trace-$t.log >&2; exit 1; }
  tail -3 /tmp/trace-$t.log
done
unset NODE_OPTIONS

echo "== prune"
rm -rf /out/root && mkdir -p /out/root
node /build/prune-tree.js /out/root /tmp/tr/*.json

echo "== lambda code"
mkdir -p /out/root/lambda/node_modules/@ghost-phase3
cp -r /tmp/work/ghost-lambda/src /tmp/work/ghost-lambda/package.json /out/root/lambda/
for m in /tmp/work/ghost-lambda/node_modules/*; do
  case "$(basename $m)" in @ghost-phase3) ;; *) cp -rL "$m" /out/root/lambda/node_modules/ ;; esac
done
cp -rL /tmp/work/sqlite-s3 /out/root/lambda/node_modules/@ghost-phase3/sqlite-s3
rm -rf /out/root/lambda/node_modules/@ghost-phase3/sqlite-s3/test
cp -r /tmp/work/ghost-lambda/test /out/root/lambda/test   # kept out of the zip; used by the local smoke run

if [ "$ARCH" = arm64 ]; then
  echo "== arm64 natives for the pruned Ghost tree"
  mkdir -p /tmp/armg && cd /tmp/armg && npm init -y >/dev/null && echo "$ALLOW" > .npmrc
  npm_config_arch=arm64 npm_config_platform=linux npm_config_target_arch=arm64 npm_config_target_platform=linux \
    npm install --no-audit --no-fund --os=linux --cpu=arm64 better-sqlite3@12.11.1 2>&1 | tail -1
  node -e "
    const fs=require('fs'),z=require('zlib');
    (async()=>{
      const r=await fetch('https://github.com/uhop/node-re2/releases/download/1.26.1/linux-arm64-$ABI.br');
      if(!r.ok) throw new Error('re2 arm64 download '+r.status);
      fs.writeFileSync('/tmp/re2-arm64.node', z.brotliDecompressSync(Buffer.from(await r.arrayBuffer())));
    })().catch(e=>{console.error(e);process.exit(1)});"
  find /out/root/node_modules -name better_sqlite3.node -exec cp /tmp/armg/node_modules/better-sqlite3/build/Release/better_sqlite3.node {} \;
  find /out/root/node_modules -name re2.node -exec cp /tmp/re2-arm64.node {} \;
fi

echo "== every better-sqlite3 in the package must carry its binary"
for d in $(find /out/root -type f -name binding.gyp -path '*better-sqlite3/binding.gyp' -exec dirname {} \;); do
  [ -f "$d/build/Release/better_sqlite3.node" ] || { echo "MISSING binary in $d" >&2; exit 1; }
done

echo "== native binaries in the package"
node -e "
  const fs=require('fs'),p=require('path');
  const m={0x3e:'x86-64',0xb7:'aarch64'};
  (function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);
    if(e.isDirectory())w(f);else if(/\.node\$/.test(e.name)){const b=Buffer.alloc(20),fd=fs.openSync(f,'r');fs.readSync(fd,b,0,20,0);fs.closeSync(fd);
    console.log((m[b.readUInt16LE(18)]||'?')+'  '+f.replace('/out/root/',''));}}})('/out/root');"
du -sm /out/root
