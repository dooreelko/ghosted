
export NODE_ENV=production url=http://localhost:2368/blog database__client=better-sqlite3 database__connection__filename=/tmp/g.db server__host=127.0.0.1 logging__level=error
export NODE_PATH=/home/ghost/node_modules:/home/ghost/core/node_modules
cp /spike/ghost-subset-harness.js /tmp/orig.js
for f in orig out out.min; do
  for i in 1 2 3; do s=$(date +%s%N); node /tmp/$f.js members > /tmp/$f.log 2>&1; e=$(date +%s%N); echo "$f wall $(( (e-s)/1000000 ))ms"; done
  grep -E 'FAILED|MEM after req|LOADED after req|ready|listening|requests done|^  [0-9]{3}|Error' /tmp/$f.log | head -14
done
