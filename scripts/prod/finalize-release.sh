#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

BACKUP_ID=""
CONFIRM_BACKUP_ID=""

usage() {
  cat <<'EOF'
用法: finalize-release.sh --backup-id ID [选项]

仅在目标版本人工验收通过后调用，把对应恢复点标记为 RELEASE_SUCCEEDED。

选项:
  --project-dir PATH       项目绝对路径
  --backup-root PATH       备份根目录
  --backup-id ID           本次发布产生的恢复点 ID
  --confirm-backup-id ID   非交互确认，必须与备份 ID 完全一致
  --health-url URL         后端健康检查地址
  --dry-run                只执行检查，不更新状态
  -h, --help               显示帮助
EOF
}

while (($#)); do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --backup-id) BACKUP_ID="$2"; shift 2 ;;
    --confirm-backup-id) CONFIRM_BACKUP_ID="$2"; shift 2 ;;
    --health-url) HEALTHCHECK_URL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ -n "$BACKUP_ID" ]] || die "必须指定 --backup-id"
for command_name in docker git flock curl realpath; do
  require_cmd "$command_name"
done
require_absolute_dir "$PROJECT_DIR" "项目目录"
PROJECT_DIR="$(canonical_path "$PROJECT_DIR")"
backup_dir="$(resolve_backup_dir "$BACKUP_ID")"

if ((DRY_RUN == 0)); then
  acquire_lock
fi

[[ "$(tr -d '\r\n' < "$backup_dir/STATUS")" == "VERIFIED" ]] \
  || die "只有 VERIFIED 恢复点可以完成发布验收"
verify_checksum_file "$backup_dir" || die "恢复点 SHA-256 校验失败"
[[ -s "$backup_dir/release-target.sha" && -s "$backup_dir/release-pending.id" ]] \
  || die "恢复点没有待验收发布记录"

target_sha="$(tr -d '\r\n' < "$backup_dir/release-target.sha")"
pending_id="$(tr -d '\r\n' < "$backup_dir/release-pending.id")"
current_sha="$(cd -- "$PROJECT_DIR" && git rev-parse HEAD)"
[[ "$pending_id" == "$BACKUP_ID" ]] || die "待验收记录与备份 ID 不一致"
[[ "$current_sha" == "$target_sha" ]] || die "当前 Git 与待验收目标不一致: current=$current_sha target=$target_sha"

wait_for_http_health 10 2
compose exec -T "$BACKEND_SERVICE" npx prisma migrate status
for service in "$DB_SERVICE" "$MINIO_SERVICE" "$BACKEND_SERVICE" "$FRONTEND_SERVICE"; do
  service_running "$service" || die "服务未运行: $service"
done

log INFO finalize_check_ok "backup_id=$BACKUP_ID target_sha=$target_sha dry_run=$DRY_RUN"
if ((DRY_RUN == 1)); then
  exit 0
fi

if [[ -n "$CONFIRM_BACKUP_ID" ]]; then
  [[ "$CONFIRM_BACKUP_ID" == "$BACKUP_ID" ]] || die "--confirm-backup-id 与备份 ID 不一致"
else
  printf '确认目标版本已完成人工验收。请输入备份 ID %s 继续: ' "$BACKUP_ID" >/dev/tty
  IFS= read -r typed_backup_id </dev/tty
  [[ "$typed_backup_id" == "$BACKUP_ID" ]] || die "确认失败，未标记发布成功"
fi

write_status "$backup_dir" RELEASE_SUCCEEDED
rm -f -- "$backup_dir/release-pending.id"
log_file_append "$backup_dir/verify.log" \
  "level=INFO event=release_complete result=passed target_sha=$target_sha"
log INFO release_complete "backup_id=$BACKUP_ID target_sha=$target_sha status=RELEASE_SUCCEEDED"
