#!/usr/bin/env bash

set -Eeuo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_DIR="$(cd -- "$TEST_DIR/.." && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
FIXTURE_DIR="$TEST_DIR/fixture"
TEST_PARENT="$REPO_ROOT/tmp"
mkdir -p -- "$TEST_PARENT"
work_dir="$(mktemp -d "$TEST_PARENT/prod-script-test.XXXXXX")"
project_dir="$work_dir/project"
backup_root="$work_dir/backup"
project_name="prod-script-test-$(date +%s)-$$"
export COMPOSE_PROJECT_NAME="$project_name"
export FIXTURE_BACKEND_PORT="32100"
export FIXTURE_FRONTEND_PORT="35174"
export PYTHON_BIN="${PYTHON_BIN:-$(command -v python)}"
export HEALTHCHECK_URL="http://127.0.0.1:$FIXTURE_BACKEND_PORT/api/health"
export PATH="$TEST_DIR/bin:$PATH"

cleanup() {
  exit_code=$?
  if [[ -d "$project_dir" ]]; then
    (cd -- "$project_dir" && docker compose down --remove-orphans >/dev/null 2>&1) || true
  fi
  while IFS= read -r volume; do
    [[ -n "$volume" && "$volume" == "$project_name"_* ]] || continue
    docker volume rm "$volume" >/dev/null 2>&1 || true
  done < <(docker volume ls --quiet --filter "label=com.docker.compose.project=$project_name")
  if [[ "$(dirname -- "$work_dir")" == "$TEST_PARENT" && "$(basename -- "$work_dir")" == prod-script-test.* ]]; then
    rm -rf -- "$work_dir"
  fi
  exit "$exit_code"
}
trap cleanup EXIT
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
(cd -- "$project_dir" && git add version.txt && git commit -q -m target)
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
PATH="$TEST_DIR/bin-low-space:$PATH" bash "$SCRIPT_DIR/preflight.sh" \
  --project-dir "$project_dir" \
  --backup-root "$backup_root" \
  --target-ref "$target_sha" \
  --dry-run >/dev/null 2>&1
low_space_status=$?
set -e
[[ "$low_space_status" != "0" ]]

result_file="$(mktemp)"
bash "$SCRIPT_DIR/backup.sh" \
  --project-dir "$project_dir" \
  --backup-root "$backup_root" \
  --target-ref "$target_sha" \
  --result-file "$result_file"
backup_id="$(tr -d '\r\n' < "$result_file")"
rm -f -- "$result_file"

(cd -- "$project_dir" && git switch -q --detach "$target_sha")
(cd -- "$project_dir" && docker compose exec -T mysql mysql -h127.0.0.1 -uroot -pfixture_root_password survey_app \
  -e "ALTER TABLE fixture_records ADD COLUMN target_only INT NULL; INSERT INTO fixture_records (value, target_only) VALUES ('mutated', 1);")
(cd -- "$project_dir" && docker compose exec -T app-backend sh -c 'printf "mutated\n" > /app/uploads/state.txt')
(cd -- "$project_dir" && docker compose exec -T minio sh -c 'printf "mutated\n" > /data/state.txt')

bash "$SCRIPT_DIR/rollback.sh" \
  --project-dir "$project_dir" \
  --backup-root "$backup_root" \
  --backup-id "$backup_id" \
  --confirm-backup-id "$backup_id" \
  --reason "isolated rollback drill" \
  --health-url "$HEALTHCHECK_URL"

[[ "$(cd -- "$project_dir" && git rev-parse HEAD)" == "$baseline_sha" ]]
[[ "$(tr -d '\r\n' < "$backup_root/releases/$backup_id/STATUS")" == "ROLLBACK_USED" ]]
[[ "$(cd -- "$project_dir" && docker compose exec -T mysql mysql -h127.0.0.1 -N -uroot -pfixture_root_password survey_app -e 'SELECT GROUP_CONCAT(value ORDER BY id) FROM fixture_records;')" == "baseline" ]]
[[ "$(cd -- "$project_dir" && docker compose exec -T mysql mysql -h127.0.0.1 -N -uroot -pfixture_root_password information_schema -e "SELECT COUNT(*) FROM COLUMNS WHERE TABLE_SCHEMA='survey_app' AND TABLE_NAME='fixture_records' AND COLUMN_NAME='target_only';")" == "0" ]]
[[ "$(cd -- "$project_dir" && MSYS_NO_PATHCONV=1 docker compose exec -T app-backend cat /app/uploads/state.txt | tr -d '\r\n')" == "baseline" ]]
[[ "$(cd -- "$project_dir" && MSYS_NO_PATHCONV=1 docker compose exec -T minio cat /data/state.txt | tr -d '\r\n')" == "baseline" ]]
curl --fail --silent "$HEALTHCHECK_URL" >/dev/null

printf 'corrupt\n' >> "$backup_root/releases/$backup_id/database.sql.gz"
set +e
bash "$SCRIPT_DIR/verify-backup.sh" \
  --project-dir "$project_dir" \
  --backup-root "$backup_root" \
  --backup-id "$backup_id" >/dev/null 2>&1
corrupt_status=$?
set -e
[[ "$corrupt_status" != "0" ]]

printf 'ROLLBACK_DRILL_OK backup_id=%s baseline_sha=%s target_sha=%s low_space=blocked corrupt_backup=blocked\n' "$backup_id" "$baseline_sha" "$target_sha"
