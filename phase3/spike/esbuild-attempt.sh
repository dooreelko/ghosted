cd /tmp && mkdir -p esb && cd esb && npm init -y >/dev/null && npm i esbuild 2>&1 | tail -1
cd /home/ghost
GHOST_CI_SHUTDOWN_AFTER_BOOT=1 NODE_ENV=production url=http://localhost:2368/blog database__client=better-sqlite3 database__connection__filename=/tmp/g.db logging__level=error node index.js >/dev/null 2>&1
JP=$(ls -d /home/ghost/node_modules/.pnpm/jsonc-parser@*/node_modules/jsonc-parser/lib/esm/main.js)
EXT="--alias:jsonc-parser=$JP --external:better-sqlite3 --external:sqlite3 --external:sharp --external:pg --external:pg-query-stream --external:mysql --external:mysql2 --external:tedious --external:oracledb --external:pg-native --external:re2 --external:dtrace-provider"
E=/tmp/esb/node_modules/.bin/esbuild
$E /spike/members-entry.js --bundle --platform=node --target=node22 --outfile=/tmp/out.js --log-level=error $EXT
$E /spike/members-entry.js --bundle --minify --platform=node --target=node22 --outfile=/tmp/out.min.js --log-level=error $EXT
sh /spike/run2.sh
