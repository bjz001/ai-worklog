ALTER TABLE `projects`
  ADD COLUMN `canonical_key` VARCHAR(512) NULL AFTER `name`;

UPDATE `projects`
   SET `canonical_key` = COALESCE(
     `normalized_git_remote`,
     CONCAT('legacy:', `id`)
   )
 WHERE `canonical_key` IS NULL;

ALTER TABLE `projects`
  MODIFY COLUMN `canonical_key` VARCHAR(512) NOT NULL,
  ADD UNIQUE KEY `uq_projects_account_canonical_key` (`account_id`, `canonical_key`);
