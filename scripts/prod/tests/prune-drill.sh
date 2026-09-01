#!/usr/bin/env bash

set -Eeuo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_DIR="$(cd -- "$TEST_DIR/.." && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
TEST_PARENT="$REPO_ROOT/tmp"
mkdir -p -- "$TEST_PARENT"
work_dir="$(mktemp -d "$TEST_PARENT/prod-prune-test.XXXXXX")"
backup_root="$work_dir/backup"
export PATH="$TEST_DIR/bin:$PATH"
export PYTHON_BIN="${PYTHON_BIN:-$(command -v python)}"

cleanup() {
  exit_code=$?
  if [[ "$(dirname -- "$work_dir")" == "$TEST_PARENT" && "$(basename -- "$work_dir")" == prod-prune-test.* ]]; then
    rm -rf -- "$work_dir"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

mkdir -p -- "$backup_root/releases"
ids=(
  20260901-030000_cccccccccccc
  20260901-020000_bbbbbbbbbbbb
  20260901-010000_aaaaaaaaaaaa
)
for backup_id in "${ids[@]}"; do
  backup_dir="$backup_root/releases/$backup_id"
  mkdir -p -- "$backup_dir"
  printf '{"backup_id":"%s"}\n' "$backup_id" > "$backup_dir/manifest.json"
  printf 'payload-%s\n' "$backup_id" > "$backup_dir/payload.bin"
  (cd -- "$backup_dir" && sha256sum manifest.json payload.bin > SHA256SUMS)
  printf 'RELEASE_SUCCEEDED\n' > "$backup_dir/STATUS"
done

bash "$SCRIPT_DIR/prune-backups.sh" --backup-root "$backup_root" --keep 2 --yes

[[ -d "$backup_root/releases/${ids[0]}" ]]
[[ -d "$backup_root/releases/${ids[1]}" ]]
[[ ! -e "$backup_root/releases/${ids[2]}" ]]
printf 'PRUNE_DRILL_OK kept=%s,%s removed=%s\n' "${ids[0]}" "${ids[1]}" "${ids[2]}"
