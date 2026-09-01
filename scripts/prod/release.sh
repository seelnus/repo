#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

TARGET_REF=""
CONFIRM_TARGET=""
MAINTENANCE_CONFIRMED=0
backup_id=""
backup_result_file=""
target_switched=0
release_ready=0
cleanup_running=0

usage() {
  cat <<'EOF'
用法: release.sh --target-ref REF [选项]

先创建并验证完整恢复点，再切换目标代码、安装依赖、执行 Prisma 迁移、启动
服务并检查健康状态。脚本完成后仍需人工验收并运行 finalize-release.sh。

选项:
  --project-dir PATH          项目绝对路径
  --backup-root PATH          备份根目录
  --target-ref REF            要发布的 Git ref（必填）
  --confirm-target SHA        非交互确认，必须是目标完整 SHA
  --health-url URL            后端健康检查地址
  --maintenance-confirmed     确认 Nginx 已阻止外部业务写入
  --dry-run                   只执行只读预检并显示计划
  -h, --help                  显示帮助
EOF
}

while (($#)); do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --target-ref) TARGET_REF="$2"; shift 2 ;;
    --confirm-target) CONFIRM_TARGET="$2"; shift 2 ;;
    --health-url) HEALTHCHECK_URL="$2"; shift 2 ;;
    --maintenance-confirmed) MAINTENANCE_CONFIRMED=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ -n "$TARGET_REF" ]] || die "必须指定 --target-ref"
for command_name in docker git flock mktemp curl; do
  require_cmd "$command_name"
done
require_absolute_dir "$PROJECT_DIR" "项目目录"
PROJECT_DIR="$(canonical_path "$PROJECT_DIR")"

current_sha="$(cd -- "$PROJECT_DIR" && git rev-parse HEAD)"
target_sha="$(cd -- "$PROJECT_DIR" && git rev-parse --verify --end-of-options "${TARGET_REF}^{commit}")"
[[ "$current_sha" != "$target_sha" ]] || die "当前已经是目标版本: $target_sha"

cleanup() {
  exit_code=$?
  ((cleanup_running == 0)) || exit "$exit_code"
  cleanup_running=1
  trap - EXIT
  [[ -z "$backup_result_file" ]] || rm -f -- "$backup_result_file"

  if ((exit_code != 0 && release_ready == 0)); then
    if [[ -n "$backup_id" && "$target_switched" == "1" ]]; then
      log ERROR release_failed "目标版本发布失败，开始恢复到 backup_id=$backup_id" >&2
      set +e
      RELEASE_ROLLBACK_TOKEN="$backup_id" bash "$SCRIPT_DIR/rollback.sh" \
        --project-dir "$PROJECT_DIR" \
        --backup-root "$BACKUP_ROOT" \
        --backup-id "$backup_id" \
        --confirm-backup-id "$backup_id" \
        --reason "automatic rollback after failed release to $target_sha" \
        --health-url "$HEALTHCHECK_URL" \
        --skip-failed-state \
        --no-lock
      rollback_status=$?
      set -e
      if ((rollback_status != 0)); then
        log ERROR automatic_rollback_failed "backup_id=$backup_id；保持维护状态，禁止恢复业务写入" >&2
      else
        log WARN automatic_rollback_complete "backup_id=$backup_id" >&2
      fi
    elif [[ -n "$backup_id" ]]; then
      log WARN release_aborted "尚未切换代码，恢复升级前服务" >&2
      compose start "$MINIO_SERVICE" "$BACKEND_SERVICE" "$FRONTEND_SERVICE" >/dev/null 2>&1 || true
    fi
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

if ((DRY_RUN == 1)); then
  bash "$SCRIPT_DIR/backup.sh" \
    --project-dir "$PROJECT_DIR" \
    --backup-root "$BACKUP_ROOT" \
    --target-ref "$target_sha" \
    --dry-run
  log INFO dry_run "将创建恢复点、保持维护、切换 $current_sha -> $target_sha、执行依赖安装与 Prisma 迁移"
  log INFO dry_run "自动检查通过后需运行 finalize-release.sh 才会标记发布成功"
  exit 0
fi

((MAINTENANCE_CONFIRMED == 1)) \
  || die "正式发布前必须先让 Nginx 阻止外部写入，然后传入 --maintenance-confirmed"

if [[ -n "$CONFIRM_TARGET" ]]; then
  [[ "$CONFIRM_TARGET" == "$target_sha" ]] || die "--confirm-target 必须等于目标完整 SHA: $target_sha"
else
  printf '即将发布目标 SHA %s。请输入完整 SHA 继续: ' "$target_sha" >/dev/tty
  IFS= read -r typed_target </dev/tty
  [[ "$typed_target" == "$target_sha" ]] || die "目标版本确认失败，已取消发布"
fi

acquire_lock
backup_result_file="$(mktemp)"
chmod 600 "$backup_result_file"

bash "$SCRIPT_DIR/backup.sh" \
  --project-dir "$PROJECT_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --target-ref "$target_sha" \
  --hold-maintenance \
  --result-file "$backup_result_file" \
  --no-lock
backup_id="$(tr -d '\r\n' < "$backup_result_file")"
valid_backup_id "$backup_id" || die "发布流程没有获得合法备份 ID"
backup_dir="$(resolve_backup_dir "$backup_id")"
[[ "$(tr -d '\r\n' < "$backup_dir/STATUS")" == "VERIFIED" ]] \
  || die "恢复点未通过验证，拒绝发布"

compose stop "$FRONTEND_SERVICE" >/dev/null
log INFO git_switch "current_sha=$current_sha target_sha=$target_sha"
(cd -- "$PROJECT_DIR" && git switch --detach "$target_sha" >/dev/null)
target_switched=1
compose config --quiet

log INFO dependency_install "安装后端依赖"
compose run --rm --no-deps "$BACKEND_SERVICE" npm ci --no-audit --no-fund
log INFO dependency_install "安装前端依赖"
compose run --rm --no-deps "$FRONTEND_SERVICE" npm ci --no-audit --no-fund
compose run --rm --no-deps "$BACKEND_SERVICE" npm run prisma:generate

log WARN migration_start "执行 Prisma 生产迁移"
compose run --rm --no-deps "$BACKEND_SERVICE" npm run prisma:deploy
compose run --rm --no-deps "$BACKEND_SERVICE" npm run seed

compose up -d "$DB_SERVICE" "$MINIO_SERVICE"
compose up -d --force-recreate "$BACKEND_SERVICE" "$FRONTEND_SERVICE"
wait_for_http_health 90 2
compose exec -T "$BACKEND_SERVICE" npx prisma migrate status

for service in "$DB_SERVICE" "$MINIO_SERVICE" "$BACKEND_SERVICE" "$FRONTEND_SERVICE"; do
  service_running "$service" || die "发布后服务未运行: $service"
done

printf '%s\n' "$target_sha" > "$backup_dir/release-target.sha"
printf '%s\n' "$backup_id" > "$backup_dir/release-pending.id"
chmod 600 "$backup_dir/release-target.sha" "$backup_dir/release-pending.id"
log_file_append "$backup_dir/verify.log" \
  "level=INFO event=release_ready target_sha=$target_sha health_url=$HEALTHCHECK_URL"
release_ready=1

log INFO release_ready "target_sha=$target_sha backup_id=$backup_id"
log WARN acceptance_required "保持 Nginx 维护状态；人工验收通过后运行 finalize-release.sh --backup-id $backup_id"
printf '%s\n' "$backup_id"
