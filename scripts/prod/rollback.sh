#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

BACKUP_ID=""
CONFIRM_BACKUP_ID=""
REASON="manual rollback"
SKIP_LOCK=0
SKIP_FAILED_STATE=0
ACCEPT_UNPROTECTED_CURRENT_STATE=0
maintenance_started=0
backup_dir=""

usage() {
  cat <<'EOF'
用法: rollback.sh --backup-id ID [选项]

把代码、数据库、uploads、MinIO 和配置完整恢复到指定恢复点。默认先为
当前失败现场再创建一份恢复点；无法创建时必须显式接受丢弃当前状态的风险。

选项:
  --project-dir PATH                    项目绝对路径
  --backup-root PATH                    备份根目录
  --backup-id ID                        要恢复的备份 ID
  --confirm-backup-id ID                非交互确认，必须与备份 ID 完全一致
  --reason TEXT                         回滚原因（写入日志）
  --health-url URL                      后端健康检查地址
  --accept-unprotected-current-state    当前状态无法备份时仍继续（高风险）
  --dry-run                             只校验恢复点并显示计划
  --skip-failed-state                   仅供受控发布失败时内部调用
  --no-lock                             仅供同一套发布脚本内部调用
  -h, --help                            显示帮助
EOF
}

while (($#)); do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --backup-id) BACKUP_ID="$2"; shift 2 ;;
    --confirm-backup-id) CONFIRM_BACKUP_ID="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --health-url) HEALTHCHECK_URL="$2"; shift 2 ;;
    --accept-unprotected-current-state) ACCEPT_UNPROTECTED_CURRENT_STATE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-failed-state) SKIP_FAILED_STATE=1; shift ;;
    --no-lock) SKIP_LOCK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ -n "$BACKUP_ID" ]] || die "必须指定 --backup-id"
if ((SKIP_FAILED_STATE == 1)); then
  [[ "$SKIP_LOCK" == "1" && "${RELEASE_ROLLBACK_TOKEN:-}" == "$BACKUP_ID" ]] \
    || die "--skip-failed-state 只能由受控发布失败流程内部调用"
fi
for command_name in docker git gzip tar sha256sum flock diff mktemp realpath curl; do
  require_cmd "$command_name"
done
require_cmd "$PYTHON_BIN"
require_absolute_dir "$PROJECT_DIR" "项目目录"
PROJECT_DIR="$(canonical_path "$PROJECT_DIR")"
validate_database_name "$DB_NAME"
backup_dir="$(resolve_backup_dir "$BACKUP_ID")"

cleanup() {
  exit_code=$?
  if ((exit_code != 0 && maintenance_started == 1)); then
    log ERROR rollback_incomplete "恢复未完成；为避免继续写入，前端、后端和 MinIO 保持停止" >&2
    compose stop "$FRONTEND_SERVICE" "$BACKEND_SERVICE" "$MINIO_SERVICE" >/dev/null 2>&1 || true
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
  VERIFIED|RELEASE_SUCCEEDED|ROLLBACK_USED) ;;
  *) die "恢复点状态不允许回滚: $status" ;;
esac

verify_checksum_file "$backup_dir" || die "恢复点 SHA-256 校验失败"
current_sha="$(manifest_value "$backup_dir/manifest.json" git.current_sha)"
target_sha="$(manifest_value "$backup_dir/manifest.json" git.target_sha)"
expected_mysql_volume="$(manifest_value "$backup_dir/manifest.json" volumes.mysql)"
expected_uploads_volume="$(manifest_value "$backup_dir/manifest.json" volumes.backend_uploads)"
expected_minio_volume="$(manifest_value "$backup_dir/manifest.json" volumes.minio_data)"

(cd -- "$PROJECT_DIR" && git rev-parse --verify --end-of-options "${current_sha}^{commit}" >/dev/null)

log WARN rollback_plan "backup_id=$BACKUP_ID status=$status restore_git=$current_sha original_target=$target_sha"
log WARN rollback_plan "将覆盖数据库=$DB_NAME uploads_volume=$expected_uploads_volume minio_volume=$expected_minio_volume"

if ((DRY_RUN == 1)); then
  bash "$SCRIPT_DIR/verify-backup.sh" \
    --project-dir "$PROJECT_DIR" \
    --backup-root "$BACKUP_ROOT" \
    --backup-id "$BACKUP_ID" \
    --dry-run \
    --no-lock
  log INFO dry_run "将停止写服务、恢复 Git/配置/数据库/文件卷并执行健康检查；未修改任何状态"
  exit 0
fi

if [[ -n "$CONFIRM_BACKUP_ID" ]]; then
  [[ "$CONFIRM_BACKUP_ID" == "$BACKUP_ID" ]] || die "--confirm-backup-id 与目标备份 ID 不一致"
else
  printf '即将完整覆盖生产数据库和文件卷。请输入备份 ID %s 继续: ' "$BACKUP_ID" >/dev/tty
  IFS= read -r typed_backup_id </dev/tty
  [[ "$typed_backup_id" == "$BACKUP_ID" ]] || die "确认失败，已取消回滚"
fi

# Destructive restoration is allowed only after a fresh integrity and temporary-import check.
bash "$SCRIPT_DIR/verify-backup.sh" \
  --project-dir "$PROJECT_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --backup-id "$BACKUP_ID" \
  --no-lock

failed_state_id=""
if ((SKIP_FAILED_STATE == 0)); then
  failed_state_result="$(mktemp)"
  chmod 600 "$failed_state_result"
  set +e
  bash "$SCRIPT_DIR/backup.sh" \
    --project-dir "$PROJECT_DIR" \
    --backup-root "$BACKUP_ROOT" \
    --target-ref HEAD \
    --hold-maintenance \
    --result-file "$failed_state_result" \
    --no-lock
  failed_state_status=$?
  set -e
  if ((failed_state_status == 0)); then
    failed_state_id="$(tr -d '\r\n' < "$failed_state_result")"
    maintenance_started=1
    log INFO failed_state_saved "backup_id=$failed_state_id"
  elif ((ACCEPT_UNPROTECTED_CURRENT_STATE == 0)); then
    rm -f -- "$failed_state_result"
    die "当前失败现场无法创建恢复点；未执行破坏性恢复。如确认丢弃当前状态，需显式使用 --accept-unprotected-current-state"
  else
    log WARN failed_state_skipped "已显式接受无法保护当前状态的风险"
    compose stop "$BACKEND_SERVICE" "$MINIO_SERVICE" >/dev/null 2>&1 || true
    maintenance_started=1
  fi
  rm -f -- "$failed_state_result"
else
  log WARN failed_state_skipped "受控发布仍处于维护窗口，没有新业务写入"
  compose stop "$BACKEND_SERVICE" "$MINIO_SERVICE" >/dev/null 2>&1 || true
  maintenance_started=1
fi

compose stop "$FRONTEND_SERVICE" >/dev/null 2>&1 || true

actual_mysql_volume="$(resolve_named_volume "$DB_SERVICE" /var/lib/mysql)"
actual_uploads_volume="$(resolve_named_volume "$BACKEND_SERVICE" /app/uploads)"
actual_minio_volume="$(resolve_named_volume "$MINIO_SERVICE" /data)"
[[ "$actual_mysql_volume" == "$expected_mysql_volume" ]] \
  || die "MySQL 卷与恢复点不一致: actual=$actual_mysql_volume expected=$expected_mysql_volume"
[[ "$actual_uploads_volume" == "$expected_uploads_volume" ]] \
  || die "uploads 卷与恢复点不一致: actual=$actual_uploads_volume expected=$expected_uploads_volume"
[[ "$actual_minio_volume" == "$expected_minio_volume" ]] \
  || die "MinIO 卷与恢复点不一致: actual=$actual_minio_volume expected=$expected_minio_volume"

dirty="$(cd -- "$PROJECT_DIR" && git status --porcelain --untracked-files=all)"
[[ -z "$dirty" ]] || die "Git 工作区不干净，拒绝切换恢复代码"

started_epoch="$(date +%s)"
log WARN rollback_start "backup_id=$BACKUP_ID reason=$REASON failed_state_id=${failed_state_id:-none}"

(cd -- "$PROJECT_DIR" && git switch --detach "$current_sha" >/dev/null)
install -m 600 "$backup_dir/environment.env" "$PROJECT_DIR/.env"
install -m 644 "$backup_dir/docker-compose.yml" "$PROJECT_DIR/docker-compose.yml"
compose config --quiet

log WARN database_restore "重建并恢复数据库=$DB_NAME"
database_identifier="$(sql_identifier "$DB_NAME")"
mysql_client -e "DROP DATABASE IF EXISTS $database_identifier; CREATE DATABASE $database_identifier CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
gzip -dc "$backup_dir/database.sql.gz" | mysql_import "$DB_NAME"

restore_volume_archive() {
  local volume="$1" archive_name="$2"
  [[ "$archive_name" == "backend-uploads.tar.gz" || "$archive_name" == "minio-data.tar.gz" ]] \
    || die "不允许的卷归档文件: $archive_name"
  log WARN volume_restore "volume=$volume archive=$archive_name"
  MSYS_NO_PATHCONV=1 docker run --rm \
    --mount "type=volume,src=$volume,dst=/target" \
    --mount "type=bind,src=$backup_dir,dst=/restore,readonly" \
    "$HELPER_IMAGE" sh -eu -c '
      find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} \;
      tar -xzf "/restore/$1" -C /target
    ' sh "$archive_name"
}

restore_volume_archive "$actual_uploads_volume" backend-uploads.tar.gz
restore_volume_archive "$actual_minio_volume" minio-data.tar.gz

compose up -d "$DB_SERVICE" "$MINIO_SERVICE"
compose run --rm --no-deps "$BACKEND_SERVICE" npm ci --no-audit --no-fund
compose run --rm --no-deps "$FRONTEND_SERVICE" npm ci --no-audit --no-fund
compose run --rm --no-deps "$BACKEND_SERVICE" npm run prisma:generate
compose up -d --force-recreate "$BACKEND_SERVICE" "$FRONTEND_SERVICE"

wait_for_http_health 90 2
compose exec -T "$BACKEND_SERVICE" npx prisma migrate status
assert_live_database_matches_backup "$backup_dir"

write_status "$backup_dir" ROLLBACK_USED
elapsed="$(( $(date +%s) - started_epoch ))"
log_file_append "$backup_dir/verify.log" \
  "level=WARN event=rollback_complete result=passed reason=$(printf '%q' "$REASON") duration_seconds=$elapsed failed_state_id=${failed_state_id:-none}"
log INFO rollback_complete "backup_id=$BACKUP_ID restored_git=$current_sha duration_seconds=$elapsed"
maintenance_started=0
