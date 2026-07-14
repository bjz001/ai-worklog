CREATE TABLE `summary_jobs` (
  `account_id` VARCHAR(64) NOT NULL,
  `work_date` DATE NOT NULL,
  `dirty_version` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`account_id`, `work_date`),
  KEY `ix_summary_jobs_account_updated` (`account_id`, `updated_at`),
  CONSTRAINT `fk_summary_jobs_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
