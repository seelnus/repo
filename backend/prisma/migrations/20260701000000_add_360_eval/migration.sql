-- CreateTable
CREATE TABLE `eval_cycles` (
    `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(200) NOT NULL,
    `scope_department` VARCHAR(200) NULL,
    `self_survey_id` INTEGER UNSIGNED NULL,
    `peer_survey_id` INTEGER UNSIGNED NULL,
    `leader_survey_id` INTEGER UNSIGNED NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'draft',
    `created_by` INTEGER UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `eval_relations` (
    `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
    `cycle_id` INTEGER UNSIGNED NOT NULL,
    `rater_contact_id` INTEGER UNSIGNED NOT NULL,
    `ratee_contact_id` INTEGER UNSIGNED NOT NULL,
    `relation_type` VARCHAR(10) NOT NULL,
    `survey_id` INTEGER UNSIGNED NOT NULL,
    `source` VARCHAR(10) NOT NULL DEFAULT 'auto',
    `response_id` INTEGER UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uk_cycle_rater_ratee`(`cycle_id`, `rater_contact_id`, `ratee_contact_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `survey_responses` ADD COLUMN `ratee_contact_id` INTEGER UNSIGNED NULL;

-- AddForeignKey
ALTER TABLE `eval_relations` ADD CONSTRAINT `eval_relations_cycle_id_fkey` FOREIGN KEY (`cycle_id`) REFERENCES `eval_cycles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
