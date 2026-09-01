#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

TARGET_REF="HEAD"
HOLD_MAINTENANCE=0
SKIP_LOCK=0
RESULT_FILE=""
backend_was_stopped=0
minio_was_stopped=0
backup_dir=""

usage() {
  cat <<'EOF'
用法: backup.sh [选项]

创建并完整验证一个生产恢复点。默认在验证结束后恢复原服务；发布脚本串联时
必须使用 --hold-maintenance，使写服务持续停止到新版本验收完成。

选项:
  --project-dir PATH      项目绝对路径
  --backup-root PATH      备份根目录
  --target-ref REF        待发布 Git ref（写入清单）
  --hold-maintenance      验证成功后仍保持后端和 MinIO 停止
  --result-file PATH      将成功生成的备份 ID 写入指定文件
  --dry-run               输出并执行只读预检，不生成恢复点或停止服务
  --no-lock               仅供同一套发布/回滚脚本内部调用
  -h, --help              显示帮助
EOF
}

while (($#)); do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --target-ref) TARGET_REF="$2"; shift 2 ;;
    --hold-maintenance) HOLD_MAINTENANCE=1; shift ;;
    --result-file) RESULT_FILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-lock) SKIP_LOCK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

if [[ -n "$RESULT_FILE" ]]; then
  [[ "$RESULT_FILE" = /* ]] || die "--result-file 必须是绝对路径"
  [[ -f "$RESULT_FILE" && ! -L "$RESULT_FILE" ]] \
    || die "--result-file 必须是调用方预先创建的普通文件"
fi

cleanup() {
  exit_code=$?
  if ((backend_was_stopped == 1 || minio_was_stopped == 1)); then
    if ((exit_code != 0 || HOLD_MAINTENANCE == 0)); then
      log INFO service_resume "恢复升级前写服务"
      resume_failed=0
      if ((minio_was_stopped == 1)) && ! compose start "$MINIO_SERVICE" >/dev/null 2>&1; then
        log ERROR service_resume_failed "service=$MINIO_SERVICE" >&2
        resume_failed=1
      fi
      if ((backend_was_stopped == 1)) && ! compose start "$BACKEND_SERVICE" >/dev/null 2>&1; then
        log ERROR service_resume_failed "service=$BACKEND_SERVICE" >&2
        resume_failed=1
      fi
      if ((resume_failed == 1)); then
        exit_code=1
      fi
    else
      log INFO maintenance_held "后端与 MinIO 保持停止，等待发布流程继续"
    fi
  fi
  if ((exit_code != 0)) && [[ -n "$backup_dir" && -d "$backup_dir" ]]; then
    log_file_append "$backup_dir/verify.log" "level=ERROR event=backup_failed exit_code=$exit_code"
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

require_cmd flock
[[ "$BACKUP_ROOT" = /* ]] || die "备份根目录必须是绝对路径"
if ((DRY_RUN == 0 && SKIP_LOCK == 0)); then
  acquire_lock
fi

preflight_args=(--project-dir "$PROJECT_DIR" --backup-root "$BACKUP_ROOT" --target-ref "$TARGET_REF" --no-lock)
if ((DRY_RUN == 1)); then
  preflight_args+=(--dry-run)
fi
bash "$SCRIPT_DIR/preflight.sh" "${preflight_args[@]}"

PROJECT_DIR="$(canonical_path "$PROJECT_DIR")"
validate_database_name "$DB_NAME"
current_sha="$(cd -- "$PROJECT_DIR" && git rev-parse HEAD)"
target_sha="$(cd -- "$PROJECT_DIR" && git rev-parse --verify --end-of-options "${TARGET_REF}^{commit}")"
short_sha="${current_sha:0:12}"
backup_id="$(date -u +%Y%m%d-%H%M%S)_$short_sha"
valid_backup_id "$backup_id" || die "备份 ID 生成失败: $backup_id"

if ((DRY_RUN == 1)); then
  log INFO dry_run "将创建 restore_point=$BACKUP_ROOT/releases/$backup_id current_sha=$current_sha target_sha=$target_sha"
  log INFO dry_run "将停止 services=$BACKEND_SERVICE,$MINIO_SERVICE，备份数据库和两个业务卷并临时恢复验证"
  exit 0
fi

backup_dir="$BACKUP_ROOT/releases/$backup_id"
[[ ! -e "$backup_dir" ]] || die "备份目录已存在: $backup_dir"
mkdir -m 700 -- "$backup_dir"
write_status "$backup_dir" CREATING
: > "$backup_dir/verify.log"
chmod 600 "$backup_dir/verify.log"

log INFO backup_start "backup_id=$backup_id current_sha=$current_sha target_sha=$target_sha"

mysql_volume="$(resolve_named_volume "$DB_SERVICE" /var/lib/mysql)"
uploads_volume="$(resolve_named_volume "$BACKEND_SERVICE" /app/uploads)"
minio_volume="$(resolve_named_volume "$MINIO_SERVICE" /data)"

branch="$(cd -- "$PROJECT_DIR" && git symbolic-ref --quiet --short HEAD || printf 'DETACHED')"
mysql_version="$(mysql_client --batch --skip-column-names -e 'SELECT VERSION();')"
compose_version="$(docker compose version --short)"
backend_cid="$(service_container_id "$BACKEND_SERVICE")"
node_version="$(docker exec "$backend_cid" node --version 2>/dev/null || printf 'unknown')"

for service in "$DB_SERVICE" "$BACKEND_SERVICE" "$MINIO_SERVICE"; do
  cid="$(service_container_id "$service")"
  image_id="$(docker inspect --format '{{.Image}}' "$cid")"
  printf '%s\t%s\n' "$service" "$image_id" >> "$backup_dir/.images.tsv"
done

log INFO maintenance_start "停止后端写入"
compose stop "$BACKEND_SERVICE" >/dev/null
backend_was_stopped=1
log INFO maintenance_start "停止 MinIO 写入"
compose stop "$MINIO_SERVICE" >/dev/null
minio_was_stopped=1

log INFO database_dump "导出数据库"
mysql_dump \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  --events \
  --hex-blob \
  --default-character-set=utf8mb4 \
  --no-tablespaces \
  --set-gtid-purged=OFF \
  "$DB_NAME" | gzip -9 > "$backup_dir/database.sql.gz"

printf 'table\trow_count\n' > "$backup_dir/row-counts.tsv"
mysql_query "$DB_NAME" \
  "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;" \
  > "$backup_dir/.tables.txt"
while IFS= read -r table_name; do
  [[ -n "$table_name" ]] || continue
  table_identifier="$(sql_identifier "$table_name")"
  count="$(mysql_query "$DB_NAME" "SELECT COUNT(*) FROM $table_identifier;")"
  printf '%s\t%s\n' "$table_name" "$count" >> "$backup_dir/row-counts.tsv"
done < "$backup_dir/.tables.txt"
rm -f -- "$backup_dir/.tables.txt"

printf 'migration_name\tfinished\trolled_back\tapplied_steps\n' > "$backup_dir/migrations.tsv"
mysql_query "$DB_NAME" \
  "SELECT migration_name, IF(finished_at IS NULL,0,1), IF(rolled_back_at IS NULL,0,1), applied_steps_count FROM _prisma_migrations ORDER BY started_at, migration_name;" \
  >> "$backup_dir/migrations.tsv"

log INFO volume_archive "归档 uploads 卷"
archive_volume "$uploads_volume" "$backup_dir/backend-uploads.tar.gz"
log INFO volume_archive "归档 MinIO 卷"
archive_volume "$minio_volume" "$backup_dir/minio-data.tar.gz"

install -m 600 "$PROJECT_DIR/.env" "$backup_dir/environment.env"
install -m 600 "$PROJECT_DIR/docker-compose.yml" "$backup_dir/docker-compose.yml"

created_at="$(timestamp)"
"$PYTHON_BIN" - "$backup_dir/manifest.json" "$backup_id" "$created_at" "$current_sha" "$target_sha" \
  "$branch" "$mysql_version" "$node_version" "$compose_version" "$DB_NAME" \
  "$mysql_volume" "$uploads_volume" "$minio_volume" "$backup_dir/.images.tsv" "$backup_dir/migrations.tsv" <<'PY'
import csv
import json
import sys

(
    output, backup_id, created_at, current_sha, target_sha, branch,
    mysql_version, node_version, compose_version, database,
    mysql_volume, uploads_volume, minio_volume, images_path, migrations_path,
) = sys.argv[1:]

images = {}
with open(images_path, encoding="utf-8") as handle:
    for service, image_id in csv.reader(handle, delimiter="\t"):
        images[service] = image_id

migrations = []
with open(migrations_path, encoding="utf-8", newline="") as handle:
    for row in csv.DictReader(handle, delimiter="\t"):
        migrations.append({
            "migration_name": row["migration_name"],
            "finished": row["finished"] == "1",
            "rolled_back": row["rolled_back"] == "1",
            "applied_steps": int(row["applied_steps"]),
        })

manifest = {
    "schema_version": 1,
    "backup_id": backup_id,
    "created_at": created_at,
    "git": {"current_sha": current_sha, "target_sha": target_sha, "branch": branch},
    "runtime": {
        "mysql_version": mysql_version,
        "node_version": node_version,
        "docker_compose_version": compose_version,
        "images": images,
    },
    "database": {"name": database, "migrations": migrations},
    "volumes": {
        "mysql": mysql_volume,
        "backend_uploads": uploads_volume,
        "minio_data": minio_volume,
    },
}
with open(output, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2, sort_keys=True)
    handle.write("\n")
PY
chmod 600 "$backup_dir/manifest.json" "$backup_dir/row-counts.tsv" "$backup_dir/migrations.tsv"
rm -f -- "$backup_dir/.images.tsv"

(
  cd -- "$backup_dir"
  sha256sum \
    database.sql.gz \
    backend-uploads.tar.gz \
    minio-data.tar.gz \
    environment.env \
    docker-compose.yml \
    manifest.json \
    row-counts.tsv \
    migrations.tsv > SHA256SUMS
  chmod 600 SHA256SUMS
)

bash "$SCRIPT_DIR/verify-backup.sh" \
  --project-dir "$PROJECT_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --backup-id "$backup_id" \
  --no-lock

log INFO backup_verified "backup_id=$backup_id status=VERIFIED path=$backup_dir"
if [[ -n "$RESULT_FILE" ]]; then
  printf '%s\n' "$backup_id" > "$RESULT_FILE"
  chmod 600 "$RESULT_FILE"
fi
printf '%s\n' "$backup_id"
