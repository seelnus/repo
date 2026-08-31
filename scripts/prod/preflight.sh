#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

TARGET_REF="HEAD"
SKIP_LOCK=0

usage() {
  cat <<'EOF'
用法: preflight.sh [选项]

选项:
  --project-dir PATH   项目绝对路径（默认 /www/wwwroot/survey-app）
  --backup-root PATH   备份根目录（默认 /www/backup/survey-app）
  --target-ref REF     待发布 Git ref（默认 HEAD）
  --dry-run            只检查，不创建权限测试库或目录
  --no-lock            仅供同一套脚本内部调用
  -h, --help           显示帮助
EOF
}

while (($#)); do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --target-ref) TARGET_REF="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-lock) SKIP_LOCK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

for command_name in docker git gzip tar sha256sum flock df awk install realpath; do
  require_cmd "$command_name"
done
require_cmd "$PYTHON_BIN"

require_absolute_dir "$PROJECT_DIR" "项目目录"
PROJECT_DIR="$(canonical_path "$PROJECT_DIR")"
[[ "$BACKUP_ROOT" = /* ]] || die "备份根目录必须是绝对路径: $BACKUP_ROOT"
validate_database_name "$DB_NAME"

if ((SKIP_LOCK == 0 && DRY_RUN == 0)); then
  acquire_lock
fi

log INFO preflight_start "project=$PROJECT_DIR target_ref=$TARGET_REF dry_run=$DRY_RUN"

(cd -- "$PROJECT_DIR" && git rev-parse --is-inside-work-tree >/dev/null)
(cd -- "$PROJECT_DIR" && git rev-parse --verify --end-of-options "${TARGET_REF}^{commit}" >/dev/null)

dirty="$(cd -- "$PROJECT_DIR" && git status --porcelain --untracked-files=all)"
[[ -z "$dirty" ]] || die "Git 工作区不干净；提交或移走改动后再备份"

compose config --quiet
docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1 || die "辅助镜像不存在，请先拉取: $HELPER_IMAGE"

for service in "$DB_SERVICE" "$BACKEND_SERVICE" "$MINIO_SERVICE"; do
  service_running "$service" || die "服务未运行: $service"
done

mysql_client --connect-timeout=10 -e 'SELECT 1' >/dev/null

failed_migrations="$(mysql_query "$DB_NAME" \
  "SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;")"
[[ "$failed_migrations" == "0" ]] || die "Prisma 存在 $failed_migrations 条未完成迁移"

non_innodb="$(mysql_query "$DB_NAME" \
  "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_TYPE='BASE TABLE' AND ENGINE <> 'InnoDB';")"
[[ -z "$non_innodb" ]] || die "存在非 InnoDB 业务表: $non_innodb"

mysql_volume="$(resolve_named_volume "$DB_SERVICE" /var/lib/mysql)"
uploads_volume="$(resolve_named_volume "$BACKEND_SERVICE" /app/uploads)"
minio_volume="$(resolve_named_volume "$MINIO_SERVICE" /data)"

[[ "$mysql_volume" != "$uploads_volume" && "$mysql_volume" != "$minio_volume" && "$uploads_volume" != "$minio_volume" ]] \
  || die "三个持久化挂载必须解析为不同的命名卷"

# Validate dump permissions without storing data.
mysql_dump --no-data --routines --triggers --events --no-tablespaces "$DB_NAME" >/dev/null

if ((DRY_RUN == 0)); then
  mkdir -p -- "$BACKUP_ROOT/releases"
  chmod 700 "$BACKUP_ROOT" "$BACKUP_ROOT/releases"
  permission_probe="$BACKUP_ROOT/.write-test.$$"
  : > "$permission_probe"
  rm -f -- "$permission_probe"

  permission_db="survey_preflight_$(date -u +%Y%m%d%H%M%S)_$$"
  [[ "$permission_db" =~ ^survey_preflight_[0-9]+_[0-9]+$ ]] || die "权限测试库名生成异常"
  trap 'mysql_client -e "DROP DATABASE IF EXISTS \`$permission_db\`;" >/dev/null 2>&1 || true' EXIT
  mysql_client -e "CREATE DATABASE \`$permission_db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; DROP DATABASE \`$permission_db\`;"
  trap - EXIT
fi

db_bytes="$(mysql_query "$DB_NAME" \
  "SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH),0) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB_NAME';")"
uploads_bytes="$(volume_size_bytes "$uploads_volume")"
minio_bytes="$(volume_size_bytes "$minio_volume")"
required_bytes="$(( (db_bytes + uploads_bytes + minio_bytes) * 3 + 2147483648 ))"

space_probe="$BACKUP_ROOT"
if [[ ! -d "$space_probe" ]]; then
  space_probe="$(dirname -- "$space_probe")"
fi
[[ -d "$space_probe" ]] || die "备份根目录的父目录不存在: $space_probe"
available_kb="$(df -Pk "$space_probe" | awk 'NR==2 {print $4}')"
available_bytes="$((available_kb * 1024))"
(( available_bytes >= required_bytes )) || die "备份磁盘空间不足: required=$required_bytes available=$available_bytes"

if [[ -d "$BACKUP_ROOT/releases" ]]; then
  while IFS= read -r status_file; do
    backup_dir="$(dirname -- "$status_file")"
    status="$(tr -d '\r\n' < "$status_file")"
    case "$status" in
      VERIFIED|RELEASE_SUCCEEDED|ROLLBACK_USED)
        verify_checksum_file "$backup_dir" || die "已有备份哈希复检失败: $(basename -- "$backup_dir")"
        ;;
    esac
  done < <(find "$BACKUP_ROOT/releases" -mindepth 2 -maxdepth 2 -type f -name STATUS -print)
fi

log INFO preflight_ok "mysql_volume=$mysql_volume uploads_volume=$uploads_volume minio_volume=$minio_volume required_bytes=$required_bytes available_bytes=$available_bytes"
