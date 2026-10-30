cd /home/ghost
export NODE_ENV=production url=http://localhost:2368/blog database__client=better-sqlite3 database__connection__filename=/tmp/g.db server__host=127.0.0.1 logging__level=error
GHOST_CI_SHUTDOWN_AFTER_BOOT=1 node index.js >/dev/null 2>&1   # migrate db
mkdir -p /tmp/tr
TRACE_OUT=/tmp/tr/members.json node -r /spike/trace.js /spike/ghost-subset-harness.js members >/dev/null 2>&1
TRACE_OUT=/tmp/tr/render.json  node -r /spike/trace.js /spike/ghost-subset-harness.js render  >/dev/null 2>&1
GHOST_CI_SHUTDOWN_AFTER_BOOT=1 TRACE_OUT=/tmp/tr/full.json node -r /spike/trace.js index.js >/dev/null 2>&1
ls -la /tmp/tr
rm -rf /tmp/pruned
node /spike/prune.js /tmp/pruned /tmp/tr/members.json /tmp/tr/render.json /tmp/tr/full.json
du -sm /tmp/pruned
for h in members render; do
  sed 's#/home/ghost#/tmp/pruned#g' /spike/ghost-subset-harness.js > /tmp/h-pruned.js
  s=$(date +%s%N); node /tmp/h-pruned.js $h >/tmp/p-$h.log 2>&1; e=$(date +%s%N)
  echo "== pruned $h $(( (e-s)/1000000 ))ms"; grep -E 'FAILED|^  [0-9]{3}|MEM after req|LOADED after req|Error' /tmp/p-$h.log | head -8
done
cd /tmp; tar czf /tmp/p.tgz pruned; ls -la /tmp/p.tgz | awk "{printf \"zipped ~%d MB\\n\", \$5/1e6}"; find /tmp/pruned -type f | wc -l; du -sm /tmp/pruned/node_modules /tmp/pruned/core 2>/dev/null
