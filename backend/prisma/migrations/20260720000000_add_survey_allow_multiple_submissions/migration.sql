-- AlterTable
ALTER TABLE `surveys`
    ADD COLUMN `allow_multiple_submissions` BOOLEAN NOT NULL DEFAULT false;
