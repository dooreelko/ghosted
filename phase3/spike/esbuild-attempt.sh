cd /tmp && mkdir -p esb && cd esb && npm init -y >/dev/null && npm i esbuild 2>&1 | tail -1
cd /home/ghost
GHOST_CI_SHUTDOWN_AFTER_BOOT=1 NODE_ENV=production url=http://localhost:2368/blog database__client=better-sqlite3 database__connection__filename=/tmp/g.db logging__level=error node index.js >/dev/null 2>&1
node /spike/build.js /spike/members-entry.js /tmp/out.js && node /spike/build.js /spike/members-entry.js /tmp/out.min.js min
cp /spike/ghost-subset-harness.js /tmp/orig.js
sh /spike/run3.sh
