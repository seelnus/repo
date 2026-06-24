CREATE TABLE `survey_whitelists` (
  `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
  `survey_id` INTEGER UNSIGNED NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `created_by` INTEGER UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `survey_whitelists_survey_id_key`(`survey_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `whitelist_members` (
  `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
  `whitelist_id` INTEGER UNSIGNED NOT NULL,
  `contact_id` INTEGER UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `uk_wl_contact`(`whitelist_id`, `contact_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `survey_whitelists`
  ADD CONSTRAINT `survey_whitelists_survey_id_fkey`
  FOREIGN KEY (`survey_id`) REFERENCES `surveys`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `survey_whitelists`
  ADD CONSTRAINT `survey_whitelists_created_by_fkey`
  FOREIGN KEY (`created_by`) REFERENCES `admin_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `whitelist_members`
  ADD CONSTRAINT `whitelist_members_whitelist_id_fkey`
  FOREIGN KEY (`whitelist_id`) REFERENCES `survey_whitelists`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `whitelist_members`
  ADD CONSTRAINT `whitelist_members_contact_id_fkey`
  FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
