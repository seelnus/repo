-- 360 环评方案 B：增量升级。保留旧字段和旧数据，现有批次 version 默认 1。
ALTER TABLE `surveys`
  MODIFY COLUMN `type` ENUM('case_collection', 'assessment', 'promotional_document', 'evaluation') NOT NULL DEFAULT 'assessment';

ALTER TABLE `eval_cycles`
  ADD COLUMN `template_survey_id` INTEGER UNSIGNED NULL,
  ADD COLUMN `template_snapshot_json` JSON NULL,
  ADD COLUMN `version` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN `start_at` DATETIME(3) NULL,
  ADD COLUMN `end_at` DATETIME(3) NULL,
  ADD COLUMN `closed_at` DATETIME(3) NULL,
  ADD COLUMN `locked_at` DATETIME(3) NULL,
  ADD COLUMN `locked_by` INTEGER UNSIGNED NULL,
  ADD COLUMN `archived_at` DATETIME(3) NULL;

ALTER TABLE `eval_relations`
  ADD COLUMN `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN `exception_reason` VARCHAR(500) NULL,
  ADD COLUMN `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

ALTER TABLE `survey_responses`
  ADD COLUMN `eval_relation_id` INTEGER UNSIGNED NULL,
  ADD COLUMN `started_at` DATETIME(3) NULL,
  ADD COLUMN `valid_status` VARCHAR(20) NOT NULL DEFAULT 'valid',
  ADD COLUMN `invalid_reason` VARCHAR(500) NULL,
  ADD COLUMN `invalidated_at` DATETIME(3) NULL,
  ADD COLUMN `invalidated_by` INTEGER UNSIGNED NULL,
  ADD COLUMN `restored_at` DATETIME(3) NULL,
  ADD COLUMN `restored_by` INTEGER UNSIGNED NULL,
  ADD INDEX `idx_response_eval_relation` (`eval_relation_id`);

CREATE TABLE `eval_cycle_participants` (
  `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
  `cycle_id` INTEGER UNSIGNED NOT NULL,
  `contact_id` INTEGER UNSIGNED NOT NULL,
  `name_snapshot` VARCHAR(100) NOT NULL,
  `job_no_snapshot` VARCHAR(50) NULL,
  `department_snapshot` VARCHAR(200) NULL,
  `position_snapshot` VARCHAR(100) NULL,
  `group_key` VARCHAR(200) NOT NULL,
  `group_name` VARCHAR(200) NOT NULL,
  `mode` VARCHAR(20) NOT NULL DEFAULT 'normal',
  `peer_exempt` BOOLEAN NOT NULL DEFAULT false,
  `exception_reason` VARCHAR(500) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `uk_eval_participant` (`cycle_id`, `contact_id`),
  INDEX `idx_eval_participant_group` (`cycle_id`, `group_key`),
  PRIMARY KEY (`id`),
  CONSTRAINT `eval_cycle_participants_cycle_id_fkey`
    FOREIGN KEY (`cycle_id`) REFERENCES `eval_cycles` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `eval_employee_results` (
  `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
  `cycle_id` INTEGER UNSIGNED NOT NULL,
  `ratee_contact_id` INTEGER UNSIGNED NOT NULL,
  `result_status` VARCHAR(20) NOT NULL DEFAULT 'provisional',
  `total_score` DECIMAL(8,4) NULL,
  `dimension_scores_json` JSON NOT NULL,
  `question_scores_json` JSON NOT NULL,
  `received_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `expected_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `template_version` INTEGER UNSIGNED NOT NULL DEFAULT 2,
  `calculated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `locked_at` DATETIME(3) NULL,
  UNIQUE INDEX `uk_eval_employee_result` (`cycle_id`, `ratee_contact_id`),
  PRIMARY KEY (`id`),
  CONSTRAINT `eval_employee_results_cycle_id_fkey`
    FOREIGN KEY (`cycle_id`) REFERENCES `eval_cycles` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `eval_audit_logs` (
  `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
  `cycle_id` INTEGER UNSIGNED NOT NULL,
  `action` VARCHAR(50) NOT NULL,
  `target_type` VARCHAR(50) NOT NULL,
  `target_id` VARCHAR(100) NULL,
  `before_json` JSON NULL,
  `after_json` JSON NULL,
  `reason` VARCHAR(500) NULL,
  `admin_id` INTEGER UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `idx_eval_audit_cycle_time` (`cycle_id`, `created_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `eval_audit_logs_cycle_id_fkey`
    FOREIGN KEY (`cycle_id`) REFERENCES `eval_cycles` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
