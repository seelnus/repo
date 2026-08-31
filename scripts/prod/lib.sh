#!/usr/bin/env bash

# Shared helpers for production backup/recovery scripts.
# This file is sourced by entrypoint scripts and is not intended to be run.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="${PROJECT_DIR:-/www/wwwroot/survey-app}"
BACKUP_ROOT="${BACKUP_ROOT:-/www/backup/survey-app}"
DB_SERVICE="${DB_SERVICE:-mysql}"
BACKEND_SERVICE="${BACKEND_SERVICE:-app-backend}"
MINIO_SERVICE="${MINIO_SERVICE:-minio}"
DB_NAME="${DB_NAME:-survey_app}"
HELPER_IMAGE="${HELPER_IMAGE:-node:20-alpine}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
DRY_RUN="${DRY_RUN:-0}"

timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log() {
  local level="$1" event="$2"
  shift 2
  printf 'time=%s level=%s event=%s message=%q\n' "$(timestamp)" "$level" "$event" "$*"
}

die() {
  log ERROR fatal "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少必需命令: $1"
}

canonical_path() {
  realpath -m -- "$1"
}

require_absolute_dir() {
  local path="$1" label="$2"
  [[ "$path" = /* ]] || die "$label 必须是绝对路径: $path"
  [[ -d "$path" ]] || die "$label 不存在: $path"
}

compose() {
  (cd -- "$PROJECT_DIR" && docker compose "$@")
}

service_container_id() {
  local service="$1" cid
  cid="$(compose ps -q "$service")"
  [[ -n "$cid" ]] || die "Compose 服务没有容器: $service"
  printf '%s\n' "$cid"
}

service_running() {
  local cid
  cid="$(service_container_id "$1")"
  [[ "$(docker inspect --format '{{.State.Running}}' "$cid")" == "true" ]]
}

resolve_named_volume() {
  local service="$1" destination="$2" cid
  cid="$(service_container_id "$service")"
  docker inspect "$cid" | MSYS_NO_PATHCONV=1 "$PYTHON_BIN" -c '
import json, sys
destination, service = sys.argv[1:]
payload = json.load(sys.stdin)
matches = [m for m in payload[0].get("Mounts", []) if m.get("Destination") == destination]
if len(matches) != 1:
    raise SystemExit(f"服务 {service} 的挂载目标 {destination} 应唯一，实际为 {len(matches)} 个")
mount = matches[0]
if mount.get("Type") != "volume" or not mount.get("Name"):
    raise SystemExit(f"服务 {service} 的 {destination} 不是 Docker 命名卷")
print(mount["Name"])
' "$destination" "$service"
}

mysql_client() {
  local cid
  cid="$(service_container_id "$DB_SERVICE")"
  docker exec "$cid" sh -eu -c '
    cfg="$(mktemp)"
    cleanup() { rm -f -- "$cfg"; }
    trap cleanup EXIT HUP INT TERM
    password="${MYSQL_ROOT_PASSWORD:-}"
    if [ -z "$password" ] && [ -n "${MYSQL_ROOT_PASSWORD_FILE:-}" ]; then
      password="$(cat -- "$MYSQL_ROOT_PASSWORD_FILE")"
    fi
    [ -n "$password" ] || { echo "MYSQL_ROOT_PASSWORD 未配置" >&2; exit 1; }
    escaped="$(printf "%s" "$password" | sed "s/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g")"
    umask 077
    printf "[client]\nuser=root\npassword=\"%s\"\n" "$escaped" > "$cfg"
    mysql --defaults-extra-file="$cfg" "$@"
  ' sh "$@"
}

mysql_import() {
  local database="$1" cid
  validate_database_name "$database"
  cid="$(service_container_id "$DB_SERVICE")"
  docker exec -i "$cid" sh -eu -c '
    cfg="$(mktemp)"
    cleanup() { rm -f -- "$cfg"; }
    trap cleanup EXIT HUP INT TERM
    password="${MYSQL_ROOT_PASSWORD:-}"
    if [ -z "$password" ] && [ -n "${MYSQL_ROOT_PASSWORD_FILE:-}" ]; then
      password="$(cat -- "$MYSQL_ROOT_PASSWORD_FILE")"
    fi
    [ -n "$password" ] || { echo "MYSQL_ROOT_PASSWORD 未配置" >&2; exit 1; }
    escaped="$(printf "%s" "$password" | sed "s/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g")"
    umask 077
    printf "[client]\nuser=root\npassword=\"%s\"\n" "$escaped" > "$cfg"
    mysql --defaults-extra-file="$cfg" "$1"
  ' sh "$database"
}

mysql_dump() {
  local cid
  cid="$(service_container_id "$DB_SERVICE")"
  docker exec -i "$cid" sh -eu -c '
    cfg="$(mktemp)"
    cleanup() { rm -f -- "$cfg"; }
    trap cleanup EXIT HUP INT TERM
    password="${MYSQL_ROOT_PASSWORD:-}"
    if [ -z "$password" ] && [ -n "${MYSQL_ROOT_PASSWORD_FILE:-}" ]; then
      password="$(cat -- "$MYSQL_ROOT_PASSWORD_FILE")"
    fi
    [ -n "$password" ] || { echo "MYSQL_ROOT_PASSWORD 未配置" >&2; exit 1; }
    escaped="$(printf "%s" "$password" | sed "s/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g")"
    umask 077
    printf "[client]\nuser=root\npassword=\"%s\"\n" "$escaped" > "$cfg"
    mysqldump --defaults-extra-file="$cfg" "$@"
  ' sh "$@"
}

mysql_query() {
  local database="$1" query="$2"
  mysql_client --batch --raw --skip-column-names "$database" -e "$query"
}

sql_identifier() {
  "$PYTHON_BIN" - "$1" <<'PY'
import sys
print("`" + sys.argv[1].replace("`", "``") + "`")
PY
}

validate_database_name() {
  [[ "$1" =~ ^[A-Za-z0-9_]+$ ]] || die "数据库名只允许字母、数字和下划线: $1"
}

write_status() {
  local backup_dir="$1" status="$2" tmp
  tmp="$backup_dir/.STATUS.tmp.$$"
  printf '%s\n' "$status" > "$tmp"
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$backup_dir/STATUS"
}

valid_backup_id() {
  [[ "$1" =~ ^[0-9]{8}-[0-9]{6}_[0-9a-f]{7,40}$ ]]
}

resolve_backup_dir() {
  local backup_id="$1" releases_root candidate resolved_root resolved
  valid_backup_id "$backup_id" || die "非法备份 ID: $backup_id"
  releases_root="$(canonical_path "$BACKUP_ROOT/releases")"
  candidate="$releases_root/$backup_id"
  [[ -d "$candidate" ]] || die "备份目录不存在: $candidate"
  resolved_root="$(canonical_path "$releases_root")"
  resolved="$(canonical_path "$candidate")"
  [[ "$resolved" == "$resolved_root/"* ]] || die "备份路径越界: $resolved"
  [[ "$(basename -- "$resolved")" == "$backup_id" ]] || die "备份目录名不匹配"
  printf '%s\n' "$resolved"
}

acquire_lock() {
  local lock_path
  mkdir -p -- "$BACKUP_ROOT"
  chmod 700 "$BACKUP_ROOT"
  lock_path="$BACKUP_ROOT/.operation.lock"
  exec 9>"$lock_path"
  flock -n 9 || die "已有备份、发布或回滚任务正在运行"
}

verify_checksum_file() {
  local backup_dir="$1"
  [[ -s "$backup_dir/SHA256SUMS" ]] || return 1
  (cd -- "$backup_dir" && sha256sum -c --quiet SHA256SUMS)
}

volume_size_bytes() {
  local volume="$1"
  MSYS_NO_PATHCONV=1 docker run --rm --mount "type=volume,src=$volume,dst=/source,readonly" \
    "$HELPER_IMAGE" sh -eu -c 'blocks="$(du -sk /source | awk '\''{print $1}'\'')"; echo $((blocks * 1024))'
}

archive_volume() {
  local volume="$1" output="$2"
  MSYS_NO_PATHCONV=1 docker run --rm --mount "type=volume,src=$volume,dst=/source,readonly" \
    "$HELPER_IMAGE" tar -czf - -C /source . > "$output"
}

log_file_append() {
  local file="$1"
  shift
  printf 'time=%s %s\n' "$(timestamp)" "$*" >> "$file"
}
