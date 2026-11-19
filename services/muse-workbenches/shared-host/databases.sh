set -eu
b=/srv/muse-workbenches
r=$b/release/20261118-01
install -d -m 0755 "$r"
docker network inspect muse-wb-network >/dev/null 2>&1 || docker network create muse-wb-network >/dev/null
for volume in muse-wb-pg muse-wb-redis; do docker volume create "$volume" >/dev/null; done
if ! docker container inspect muse-wb-pg17 >/dev/null 2>&1; then
 docker run -d --pull=never --name muse-wb-pg17 --network muse-wb-network --restart unless-stopped --memory=3g --cpus=2 -p 127.0.0.1:19746:5432 -v muse-wb-pg:/home/postgres/pgdata/data --env-file "$b/config/bootstrap/postgres.env" timescale/timescaledb-ha:pg17 postgres >/dev/null
fi
if ! docker container inspect muse-wb-redis >/dev/null 2>&1; then
 docker run -d --pull=never --name muse-wb-redis --network muse-wb-network --restart unless-stopped --memory=640m --cpus=1 -p 127.0.0.1:19747:6379 -v muse-wb-redis:/data -v "$b/config/bootstrap/redis.conf:/usr/local/etc/redis/redis.conf:ro" redis:8-alpine redis-server /usr/local/etc/redis/redis.conf >/dev/null
fi
docker ps --format '{{.Names}} {{.Status}}' --filter name=muse-wb
