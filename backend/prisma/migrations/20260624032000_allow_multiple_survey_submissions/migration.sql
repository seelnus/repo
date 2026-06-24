CREATE INDEX `idx_survey_responses_survey_id` ON `survey_responses`(`survey_id`);

DROP INDEX `uk_one_submission` ON `survey_responses`;
