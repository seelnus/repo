#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<'EOF'
用法: list-backups.sh [--backup-root PATH] [--dry-run]
只读取并列出恢复点，不显示 environment.env 中的任何内容。
EOF
}

while (($#)); do
  case "$1" in
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

require_cmd "$PYTHON_BIN"
[[ "$BACKUP_ROOT" = /* ]] || die "备份根目录必须是绝对路径"
releases_root="$BACKUP_ROOT/releases"

printf 'BACKUP_ID\tSTATUS\tCREATED_AT\tCURRENT_GIT\tTARGET_GIT\tCHECKSUM\n'
[[ -d "$releases_root" ]] || exit 0

while IFS= read -r backup_dir; do
  backup_id="$(basename -- "$backup_dir")"
  valid_backup_id "$backup_id" || continue
  status="MISSING"
  [[ ! -f "$backup_dir/STATUS" ]] || status="$(tr -d '\r\n' < "$backup_dir/STATUS")"
  checksum="MISSING"
  if [[ -f "$backup_dir/SHA256SUMS" ]]; then
    if verify_checksum_file "$backup_dir" >/dev/null 2>&1; then checksum="OK"; else checksum="FAILED"; fi
  fi
  if [[ -f "$backup_dir/manifest.json" ]]; then
    "$PYTHON_BIN" - "$backup_dir/manifest.json" "$backup_id" "$status" "$checksum" <<'PY'
import json
import sys

path, backup_id, status, checksum = sys.argv[1:]
try:
    with open(path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    created = manifest.get("created_at", "UNKNOWN")
    git = manifest.get("git", {})
    current = git.get("current_sha", "UNKNOWN")[:12]
    target = git.get("target_sha", "UNKNOWN")[:12]
except Exception:
    created = current = target = "INVALID_MANIFEST"
print("\t".join((backup_id, status, created, current, target, checksum)))
PY
  else
    printf '%s\t%s\tMISSING\tMISSING\tMISSING\t%s\n' "$backup_id" "$status" "$checksum"
  fi
done < <(find "$releases_root" -mindepth 1 -maxdepth 1 -type d -print | sort -r)
