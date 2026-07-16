CREATE TABLE `period_summary_evidence` (
  `id` VARCHAR(64) NOT NULL,
  `account_id` VARCHAR(64) NOT NULL,
  `summary_id` VARCHAR(64) NOT NULL,
  `collected_event_id` VARCHAR(64) NOT NULL,
  `claim_key` VARCHAR(128) NOT NULL,
  `claim_type` ENUM('FACT', 'INFERENCE', 'SUGGESTION', 'INFORMATION_MISSING') NOT NULL,
  `excerpt` TEXT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_period_summary_evidence_claim_event` (`summary_id`, `claim_key`, `collected_event_id`),
  KEY `ix_period_summary_evidence_account_event` (`account_id`, `collected_event_id`),
  CONSTRAINT `fk_period_summary_evidence_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_period_summary_evidence_summary` FOREIGN KEY (`summary_id`) REFERENCES `period_summaries` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_period_summary_evidence_event` FOREIGN KEY (`collected_event_id`) REFERENCES `collected_events` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
