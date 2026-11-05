cd /home/ghost
export NODE_ENV=production url=http://localhost:2368/blog database__client=better-sqlite3 database__connection__filename=/tmp/g.db server__host=127.0.0.1 logging__level=error NODE_PATH=/home/ghost/node_modules
ls -la /tmp/out*.js | awk '{print $5, $9}'
t() { # name file cache
  for i in 1 2 3 4; do
    s=$(date +%s%N); if [ "$3" = cc ]; then NODE_COMPILE_CACHE=/tmp/cc-$1 node $2 members >/tmp/$1.log 2>&1; else node $2 members >/tmp/$1.log 2>&1; fi; e=$(date +%s%N)
    echo "$1${3:+ +cache} run$i $(( (e-s)/1000000 ))ms"
  done
  grep -E 'FAILED|MEM after req|LOADED after req' /tmp/$1.log
}
t orig /tmp/orig.js; t orig /tmp/orig.js cc
t bundle /tmp/out.js; t bundle /tmp/out.js cc
t bundlemin /tmp/out.min.js; t bundlemin /tmp/out.min.js cc
