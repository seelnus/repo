-- 第一阶段：通讯录与多级组织架构。
-- 只新增组织数据结构并放开联系人同名；现有 department 文本保留给旧 360 逻辑。

DROP INDEX `contacts_name_key` ON `contacts`;

ALTER TABLE `contacts`
  ADD COLUMN `is_active` BOOLEAN NOT NULL DEFAULT true,
  ADD INDEX `idx_contacts_phone` (`phone`),
  ADD INDEX `idx_contacts_job_no` (`job_no`),
  ADD INDEX `idx_contacts_active` (`is_active`);

CREATE TABLE `org_departments` (
  `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(64) NOT NULL,
  `name` VARCHAR(200) NOT NULL,
  `parent_id` INTEGER UNSIGNED NULL,
  `sort_order` INTEGER NOT NULL DEFAULT 0,
  `is_active` BOOLEAN NOT NULL DEFAULT true,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `org_departments_code_key` (`code`),
  UNIQUE INDEX `uk_org_department_parent_name` (`parent_id`, `name`),
  INDEX `idx_org_department_parent_sort` (`parent_id`, `sort_order`),
  INDEX `idx_org_department_active` (`is_active`),
  PRIMARY KEY (`id`),
  CONSTRAINT `org_departments_parent_id_fkey`
    FOREIGN KEY (`parent_id`) REFERENCES `org_departments` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `contact_department_memberships` (
  `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
  `contact_id` INTEGER UNSIGNED NOT NULL,
  `department_id` INTEGER UNSIGNED NOT NULL,
  `is_primary` BOOLEAN NOT NULL DEFAULT false,
  `default_eval_enabled` BOOLEAN NOT NULL DEFAULT false,
  `role_name` VARCHAR(100) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `uk_contact_department` (`contact_id`, `department_id`),
  INDEX `idx_membership_department_primary` (`department_id`, `is_primary`),
  INDEX `idx_membership_contact_primary` (`contact_id`, `is_primary`),
  PRIMARY KEY (`id`),
  CONSTRAINT `contact_department_memberships_contact_id_fkey`
    FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `contact_department_memberships_department_id_fkey`
    FOREIGN KEY (`department_id`) REFERENCES `org_departments` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
