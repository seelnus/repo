#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

BACKUP_ID=""
SKIP_LOCK=0
verify_db=""
work_dir=""
log_path=""

usage() {
  cat <<'EOF'
用法: verify-backup.sh --backup-id ID [选项]

选项:
  --project-dir PATH   项目绝对路径
  --backup-root PATH   备份根目录
  --backup-id ID       要验证的恢复点 ID
  --dry-run            仅验证路径、状态与执行计划
  --no-lock            仅供同一套脚本内部调用
  -h, --help           显示帮助
EOF
}

while (($#)); do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --backup-id) BACKUP_ID="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-lock) SKIP_LOCK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ -n "$BACKUP_ID" ]] || die "必须指定 --backup-id"
for command_name in docker gzip tar sha256sum flock diff mktemp realpath; do
  require_cmd "$command_name"
done
require_cmd "$PYTHON_BIN"

require_absolute_dir "$PROJECT_DIR" "项目目录"
PROJECT_DIR="$(canonical_path "$PROJECT_DIR")"
validate_database_name "$DB_NAME"
backup_dir="$(resolve_backup_dir "$BACKUP_ID")"
log_path="$backup_dir/verify.log"

cleanup() {
  exit_code=$?
  if [[ -n "$verify_db" && "$verify_db" =~ ^survey_verify_[0-9]+_[0-9]+$ && "$verify_db" != "$DB_NAME" ]]; then
    mysql_client -e "DROP DATABASE IF EXISTS \`$verify_db\`;" >/dev/null 2>&1 || true
  fi
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -f -- "$work_dir/actual-row-counts.tsv" "$work_dir/actual-migrations.tsv" "$work_dir/actual-tables.txt"
    rmdir -- "$work_dir" 2>/dev/null || true
  fi
  if [[ -n "$log_path" ]]; then
    if ((exit_code == 0)); then
      log_file_append "$log_path" "level=INFO event=verify_complete result=passed"
    else
      log_file_append "$log_path" "level=ERROR event=verify_complete result=failed exit_code=$exit_code"
    fi
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

if ((SKIP_LOCK == 0 && DRY_RUN == 0)); then
  acquire_lock
fi

status="$(tr -d '\r\n' < "$backup_dir/STATUS")"
case "$status" in
  CREATING|VERIFIED|RELEASE_SUCCEEDED|ROLLBACK_USED) ;;
  *) die "不支持的备份状态: $status" ;;
esac

if ((DRY_RUN == 1)); then
  log INFO dry_run "将验证 backup_id=$BACKUP_ID status=$status，并恢复到随机临时库后逐表核对"
  exit 0
fi

started_epoch="$(date +%s)"
log_file_append "$log_path" "level=INFO event=verify_start backup_id=$BACKUP_ID"

required_files=(
  database.sql.gz backend-uploads.tar.gz minio-data.tar.gz environment.env
  docker-compose.yml manifest.json row-counts.tsv migrations.tsv SHA256SUMS verify.log STATUS
)
for filename in "${required_files[@]}"; do
  [[ -s "$backup_dir/$filename" ]] || die "备份文件缺失或为空: $filename"
done

"$PYTHON_BIN" - "$backup_dir/manifest.json" "$BACKUP_ID" "$DB_NAME" "$backup_dir/migrations.tsv" <<'PY'
import csv
import json
import sys

path, expected_id, expected_db, migrations_path = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    manifest = json.load(handle)
if manifest.get("schema_version") != 1:
    raise SystemExit("manifest schema_version 不支持")
if manifest.get("backup_id") != expected_id:
    raise SystemExit("manifest backup_id 与目录不一致")
if manifest.get("database", {}).get("name") != expected_db:
    raise SystemExit("manifest 数据库名与配置不一致")
with open(migrations_path, encoding="utf-8", newline="") as handle:
    rows = list(csv.DictReader(handle, delimiter="\t"))
expected_migrations = [
    {
        "migration_name": row["migration_name"],
        "finished": row["finished"] == "1",
        "rolled_back": row["rolled_back"] == "1",
        "applied_steps": int(row["applied_steps"]),
    }
    for row in rows
]
if manifest.get("database", {}).get("migrations") != expected_migrations:
    raise SystemExit("manifest 与 migrations.tsv 不一致")
PY

verify_checksum_file "$backup_dir" || die "SHA-256 校验失败"
gzip -t "$backup_dir/database.sql.gz"
tar -tzf "$backup_dir/backend-uploads.tar.gz" >/dev/null
tar -tzf "$backup_dir/minio-data.tar.gz" >/dev/null

set +e
# The single-quoted payload is Python source and must not be expanded by Bash.
# shellcheck disable=SC2016
gzip -dc "$backup_dir/database.sql.gz" | "$PYTHON_BIN" -c '
import re, sys
database = re.escape(sys.argv[1])
pattern = re.compile(rf"^\s*(?:CREATE\s+DATABASE|USE\s+`?{database}`?)", re.IGNORECASE)
found = False
for raw_line in sys.stdin.buffer:
    if pattern.search(raw_line.decode("utf-8", errors="ignore")):
        found = True
raise SystemExit(42 if found else 0)
' "$DB_NAME"
scan_status=$?
set -e
case "$scan_status" in
  0) ;;
  42) die "数据库备份含 CREATE DATABASE 或固定 USE $DB_NAME，拒绝临时恢复" ;;
  *) die "数据库备份安全扫描失败: exit_code=$scan_status" ;;
esac

verify_db="survey_verify_$(date -u +%Y%m%d%H%M%S)_$$"
[[ "$verify_db" =~ ^survey_verify_[0-9]+_[0-9]+$ && "$verify_db" != "$DB_NAME" ]] || die "临时验证库名不安全"
mysql_client -e "CREATE DATABASE \`$verify_db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

gzip -dc "$backup_dir/database.sql.gz" | mysql_import "$verify_db"

work_dir="$(mktemp -d)"
printf 'table\trow_count\n' > "$work_dir/actual-row-counts.tsv"
mysql_query "$verify_db" \
  "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$verify_db' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;" \
  > "$work_dir/actual-tables.txt"
while IFS= read -r table_name; do
  [[ -n "$table_name" ]] || continue
  table_identifier="$(sql_identifier "$table_name")"
  actual_count="$(mysql_query "$verify_db" "SELECT COUNT(*) FROM $table_identifier;")"
  printf '%s\t%s\n' "$table_name" "$actual_count" >> "$work_dir/actual-row-counts.tsv"
done < "$work_dir/actual-tables.txt"
if ! diff -u "$backup_dir/row-counts.tsv" "$work_dir/actual-row-counts.tsv" >> "$log_path"; then
  die "恢复后的表集合或行数不一致"
fi

printf 'migration_name\tfinished\trolled_back\tapplied_steps\n' > "$work_dir/actual-migrations.tsv"
mysql_query "$verify_db" \
  "SELECT migration_name, IF(finished_at IS NULL,0,1), IF(rolled_back_at IS NULL,0,1), applied_steps_count FROM _prisma_migrations ORDER BY started_at, migration_name;" \
  >> "$work_dir/actual-migrations.tsv"
if ! diff -u "$backup_dir/migrations.tsv" "$work_dir/actual-migrations.tsv" >> "$log_path"; then
  die "Prisma 迁移记录不一致"
fi

mysql_client -e "DROP DATABASE \`$verify_db\`;"
verify_db=""
if [[ "$status" == "CREATING" ]]; then
  write_status "$backup_dir" VERIFIED
fi
elapsed="$(( $(date +%s) - started_epoch ))"
log_file_append "$log_path" "level=INFO event=restore_validation result=passed duration_seconds=$elapsed temp_database=$verify_db"
log INFO verify_ok "backup_id=$BACKUP_ID duration_seconds=$elapsed"
