#!/usr/bin/env bash

set -Eeuo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_DIR="$(cd -- "$TEST_DIR/.." && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
FIXTURE_DIR="$TEST_DIR/fixture"
TEST_PARENT="$REPO_ROOT/tmp"
mkdir -p -- "$TEST_PARENT"
export PYTHON_BIN="${PYTHON_BIN:-$(command -v python)}"
export PATH="$TEST_DIR/bin:$PATH"

run_case() (
  set -Eeuo pipefail
  local case_name="$1" expect_failure="$2"
  local work_dir project_dir backup_root project_name backend_port frontend_port
  local baseline_sha target_sha release_status backup_id

  work_dir="$(mktemp -d "$TEST_PARENT/prod-release-test.XXXXXX")"
  project_dir="$work_dir/project"
  backup_root="$work_dir/backup"
  project_name="prod-release-$case_name-$(date +%s)-$$"
  backend_port="$3"
  frontend_port="$4"
  export COMPOSE_PROJECT_NAME="$project_name"
  export FIXTURE_BACKEND_PORT="$backend_port"
  export FIXTURE_FRONTEND_PORT="$frontend_port"
  export HEALTHCHECK_URL="http://127.0.0.1:$backend_port/api/health"

  cleanup_case() {
    exit_code=$?
    if [[ -d "$project_dir" ]]; then
      (cd -- "$project_dir" && docker compose down --remove-orphans >/dev/null 2>&1) || true
    fi
    while IFS= read -r volume; do
      [[ -n "$volume" && "$volume" == "$project_name"_* ]] || continue
      docker volume rm "$volume" >/dev/null 2>&1 || true
    done < <(docker volume ls --quiet --filter "label=com.docker.compose.project=$project_name")
    if [[ "$(dirname -- "$work_dir")" == "$TEST_PARENT" && "$(basename -- "$work_dir")" == prod-release-test.* ]]; then
      rm -rf -- "$work_dir"
    fi
    exit "$exit_code"
  }
  trap cleanup_case EXIT
  trap 'exit 130' HUP INT TERM

  mkdir -p -- "$project_dir" "$backup_root"
  cp -R -- "$FIXTURE_DIR/." "$project_dir/"
  install -m 600 "$project_dir/.env.example" "$project_dir/.env"
  (cd -- "$project_dir" && npm --prefix backend install --package-lock-only --ignore-scripts >/dev/null)
  (cd -- "$project_dir" && npm --prefix frontend install --package-lock-only --ignore-scripts >/dev/null)
  (cd -- "$project_dir" && git init -q -b main && git config user.name fixture && git config user.email fixture@example.invalid)
  printf 'baseline\n' > "$project_dir/version.txt"
  (cd -- "$project_dir" && git add . && git commit -q -m baseline)
  baseline_sha="$(cd -- "$project_dir" && git rev-parse HEAD)"
  printf 'target\n' > "$project_dir/version.txt"
  if [[ "$expect_failure" == "1" ]]; then
    : > "$project_dir/backend/FAIL_MIGRATION"
  fi
  (cd -- "$project_dir" && git add . && git commit -q -m target)
  target_sha="$(cd -- "$project_dir" && git rev-parse HEAD)"
  (cd -- "$project_dir" && git switch -q --detach "$baseline_sha")

  (cd -- "$project_dir" && docker compose up -d)
  for _ in {1..60}; do
    if (cd -- "$project_dir" && docker compose exec -T mysql \
        mysql -h127.0.0.1 -uroot -pfixture_root_password -e 'SELECT 1' >/dev/null 2>&1); then
      break
    fi
    sleep 1
  done
  (cd -- "$project_dir" && docker compose exec -T mysql \
    mysql -h127.0.0.1 -uroot -pfixture_root_password -e 'SELECT 1' >/dev/null)
  for _ in {1..60}; do
    if curl --fail --silent "$HEALTHCHECK_URL" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  curl --fail --silent "$HEALTHCHECK_URL" >/dev/null

  (cd -- "$project_dir" && docker compose exec -T mysql mysql -h127.0.0.1 -uroot -pfixture_root_password survey_app <<'SQL')
CREATE TABLE `_prisma_migrations` (
  `id` VARCHAR(36) NOT NULL,
  `checksum` VARCHAR(64) NOT NULL,
  `finished_at` DATETIME(3) NULL,
  `migration_name` VARCHAR(255) NOT NULL,
  `logs` TEXT NULL,
  `rolled_back_at` DATETIME(3) NULL,
  `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `applied_steps_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;
INSERT INTO `_prisma_migrations`
  (`id`, `checksum`, `finished_at`, `migration_name`, `applied_steps_count`)
VALUES
  ('baseline-id', 'fixture-checksum', NOW(3), '20260901000000_baseline', 1);
CREATE TABLE `fixture_records` (
  `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
  `value` VARCHAR(100) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;
INSERT INTO `fixture_records` (`value`) VALUES ('baseline');
SQL
  (cd -- "$project_dir" && docker compose exec -T app-backend sh -c 'printf "baseline\n" > /app/uploads/state.txt')
  (cd -- "$project_dir" && docker compose exec -T minio sh -c 'printf "baseline\n" > /data/state.txt')

  set +e
  bash "$SCRIPT_DIR/release.sh" \
    --project-dir "$project_dir" \
    --backup-root "$backup_root" \
    --target-ref "$target_sha" \
    --confirm-target "$target_sha" \
    --health-url "$HEALTHCHECK_URL" \
    --maintenance-confirmed
  release_status=$?
  set -e

  if [[ "$expect_failure" == "1" ]]; then
    [[ "$release_status" != "0" ]]
    [[ "$(cd -- "$project_dir" && git rev-parse HEAD)" == "$baseline_sha" ]]
    backup_id="$(find "$backup_root/releases" -mindepth 1 -maxdepth 1 -type d -name "*_${baseline_sha:0:12}" -printf '%f\n' | sort | tail -1)"
    [[ -n "$backup_id" ]]
    [[ "$(tr -d '\r\n' < "$backup_root/releases/$backup_id/STATUS")" == "ROLLBACK_USED" ]]
    [[ "$(cd -- "$project_dir" && docker compose exec -T mysql mysql -h127.0.0.1 -N -uroot -pfixture_root_password survey_app -e 'SELECT GROUP_CONCAT(value ORDER BY id) FROM fixture_records;')" == "baseline" ]]
    [[ "$(cd -- "$project_dir" && MSYS_NO_PATHCONV=1 docker compose exec -T app-backend cat /app/uploads/state.txt | tr -d '\r\n')" == "baseline" ]]
    [[ "$(cd -- "$project_dir" && MSYS_NO_PATHCONV=1 docker compose exec -T minio cat /data/state.txt | tr -d '\r\n')" == "baseline" ]]
    curl --fail --silent "$HEALTHCHECK_URL" >/dev/null
    printf 'RELEASE_FAILURE_ROLLBACK_OK backup_id=%s\n' "$backup_id"
  else
    [[ "$release_status" == "0" ]]
    [[ "$(cd -- "$project_dir" && git rev-parse HEAD)" == "$target_sha" ]]
    pending_file="$(find "$backup_root/releases" -mindepth 2 -maxdepth 2 -type f -name release-pending.id -print -quit)"
    [[ -n "$pending_file" ]]
    backup_id="$(tr -d '\r\n' < "$pending_file")"
    [[ "$(tr -d '\r\n' < "$backup_root/releases/$backup_id/STATUS")" == "VERIFIED" ]]
    bash "$SCRIPT_DIR/finalize-release.sh" \
      --project-dir "$project_dir" \
      --backup-root "$backup_root" \
      --backup-id "$backup_id" \
      --confirm-backup-id "$backup_id" \
      --health-url "$HEALTHCHECK_URL"
    [[ "$(tr -d '\r\n' < "$backup_root/releases/$backup_id/STATUS")" == "RELEASE_SUCCEEDED" ]]
    curl --fail --silent "$HEALTHCHECK_URL" >/dev/null
    printf 'RELEASE_SUCCESS_FINALIZE_OK backup_id=%s\n' "$backup_id"
  fi
)

case "${1:-all}" in
  all)
    run_case success 0 32110 35184
    run_case failure 1 32120 35194
    ;;
  success) run_case success 0 32110 35184 ;;
  failure) run_case failure 1 32120 35194 ;;
  *) printf '用法: %s [all|success|failure]\n' "$0" >&2; exit 2 ;;
esac
printf 'RELEASE_DRILL_OK\n'
