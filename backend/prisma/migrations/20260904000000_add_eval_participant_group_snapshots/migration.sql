-- V2 360 环评多部门小组快照。
-- 仅新增批次快照表，不回填或改写历史批次数据。

CREATE TABLE `eval_participant_group_snapshots` (
  `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
  `participant_id` INTEGER UNSIGNED NOT NULL,
  `department_id` INTEGER UNSIGNED NOT NULL,
  `department_code_snapshot` VARCHAR(64) NOT NULL,
  `department_name_snapshot` VARCHAR(200) NOT NULL,
  `department_path_snapshot` VARCHAR(1000) NOT NULL,
  `is_primary_snapshot` BOOLEAN NOT NULL DEFAULT false,
  `eval_enabled` BOOLEAN NOT NULL DEFAULT false,
  `role_name_snapshot` VARCHAR(100) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `uk_eval_participant_department` (`participant_id`, `department_id`),
  INDEX `idx_eval_group_department_enabled` (`department_id`, `eval_enabled`),
  INDEX `idx_eval_group_participant_enabled` (`participant_id`, `eval_enabled`),
  PRIMARY KEY (`id`),
  CONSTRAINT `eval_participant_group_snapshots_participant_id_fkey`
    FOREIGN KEY (`participant_id`) REFERENCES `eval_cycle_participants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `eval_participant_group_snapshots_department_id_fkey`
    FOREIGN KEY (`department_id`) REFERENCES `org_departments` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
