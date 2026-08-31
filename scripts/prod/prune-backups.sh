#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

KEEP=2
CONFIRMED=0

usage() {
  cat <<'EOF'
用法: prune-backups.sh [选项]

仅清理状态为 RELEASE_SUCCEEDED 的旧恢复点；VERIFIED、CREATING、
ROLLBACK_USED 均不会自动删除。默认只预览，必须同时提供 --yes 才会删除。

选项:
  --backup-root PATH   备份根目录
  --keep N             保留最近 N 个成功发布恢复点（默认 2，最小 2）
  --dry-run            仅预览（默认行为）
  --yes                确认执行安全删除
  -h, --help           显示帮助
EOF
}

while (($#)); do
  case "$1" in
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) CONFIRMED=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ "$KEEP" =~ ^[0-9]+$ ]] || die "--keep 必须是整数"
((KEEP >= 2)) || die "安全策略要求至少保留 2 个版本"
[[ "$BACKUP_ROOT" = /* ]] || die "备份根目录必须是绝对路径"
require_cmd flock
require_cmd "$PYTHON_BIN"
require_cmd realpath

if ((CONFIRMED == 0)); then
  DRY_RUN=1
fi
if ((DRY_RUN == 0)); then
  acquire_lock
fi

releases_root="$BACKUP_ROOT/releases"
[[ -d "$releases_root" ]] || { log INFO prune_noop "没有备份目录"; exit 0; }
resolved_root="$(canonical_path "$releases_root")"

eligible=()
while IFS= read -r backup_dir; do
  backup_id="$(basename -- "$backup_dir")"
  valid_backup_id "$backup_id" || continue
  [[ -f "$backup_dir/STATUS" && "$(tr -d '\r\n' < "$backup_dir/STATUS")" == "RELEASE_SUCCEEDED" ]] || continue
  [[ -f "$backup_dir/manifest.json" ]] || continue
  "$PYTHON_BIN" - "$backup_dir/manifest.json" "$backup_id" <<'PY' || continue
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)
raise SystemExit(0 if manifest.get("backup_id") == sys.argv[2] else 1)
PY
  verify_checksum_file "$backup_dir" || die "候选备份哈希失败，停止清理: $backup_id"
  eligible+=("$backup_id")
done < <(find "$releases_root" -mindepth 1 -maxdepth 1 -type d -print | sort -r)

if ((${#eligible[@]} <= KEEP)); then
  log INFO prune_noop "成功发布恢复点数量=${#eligible[@]} keep=$KEEP"
  exit 0
fi

for ((index=KEEP; index<${#eligible[@]}; index++)); do
  backup_id="${eligible[$index]}"
  backup_dir="$(resolve_backup_dir "$backup_id")"
  resolved="$(canonical_path "$backup_dir")"
  [[ "$resolved" == "$resolved_root/"* ]] || die "删除目标路径越界: $resolved"
  [[ "$(basename -- "$resolved")" == "$backup_id" ]] || die "删除目标目录名异常"
  if ((DRY_RUN == 1)); then
    log INFO prune_preview "would_delete=$resolved"
  else
    log WARN prune_delete "backup_id=$backup_id path=$resolved"
    rm -rf -- "$resolved"
  fi
done
