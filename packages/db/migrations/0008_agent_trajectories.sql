ALTER TABLE `sync_batches`
  MODIFY COLUMN `source_type` VARCHAR(32) NOT NULL;

ALTER TABLE `sessions`
  DROP INDEX `uq_sessions_source_identity`,
  MODIFY COLUMN `source_type` VARCHAR(32) NOT NULL,
  MODIFY COLUMN `source_session_id` TEXT NOT NULL,
  ADD COLUMN `source_session_key` CHAR(64) NULL AFTER `source_session_id`,
  ADD COLUMN `run_id` CHAR(64) NULL AFTER `source_session_id`,
  ADD COLUMN `title` TEXT NULL AFTER `ended_at`,
  ADD COLUMN `cwd` TEXT NULL AFTER `title`,
  ADD COLUMN `parent_run_id` CHAR(64) NULL AFTER `cwd`,
  ADD COLUMN `raw_capture_status` VARCHAR(32) NOT NULL DEFAULT 'CAPTURED' AFTER `parent_run_id`,
  ADD COLUMN `normalized_coverage` VARCHAR(32) NOT NULL DEFAULT 'FULL' AFTER `raw_capture_status`,
  ADD COLUMN `attachment_status` VARCHAR(32) NOT NULL DEFAULT 'NOT_APPLICABLE' AFTER `normalized_coverage`,
  ADD COLUMN `missing_reason` TEXT NULL AFTER `attachment_status`,
  ADD COLUMN `agent_metadata` JSON NULL AFTER `missing_reason`,
  ADD UNIQUE KEY `uq_sessions_source_identity_v2` (`account_id`, `source_type`, `source_instance_id`, `source_session_key`),
  ADD UNIQUE KEY `uq_sessions_account_run_id` (`account_id`, `run_id`),
  ADD KEY `ix_sessions_account_source_started` (`account_id`, `source_type`, `started_at`);

UPDATE `sessions`
   SET `source_session_key` = SHA2(`source_session_id`, 256)
 WHERE `source_session_key` IS NULL;

ALTER TABLE `sessions`
  MODIFY COLUMN `source_session_key` CHAR(64) NOT NULL;

ALTER TABLE `collected_events`
  MODIFY COLUMN `kind` VARCHAR(64) NOT NULL,
  MODIFY COLUMN `source_message_id` VARCHAR(1024) NULL,
  MODIFY COLUMN `message_index` BIGINT UNSIGNED NULL,
  MODIFY COLUMN `content_hash` CHAR(64) NULL,
  MODIFY COLUMN `redaction_version` VARCHAR(32) NULL,
  ADD COLUMN `source_event_id` VARCHAR(1024) NULL AFTER `event_id`,
  ADD COLUMN `sequence` BIGINT UNSIGNED NULL AFTER `source_event_id`,
  ADD COLUMN `turn_index` INT UNSIGNED NULL AFTER `sequence`,
  ADD COLUMN `step_index` INT UNSIGNED NULL AFTER `turn_index`,
  ADD COLUMN `mirror_of_event_id` CHAR(64) NULL AFTER `reply_to_event_id`,
  ADD COLUMN `raw_payload_sha256` CHAR(64) NULL AFTER `content_hash`,
  ADD COLUMN `raw_capture_status` VARCHAR(32) NOT NULL DEFAULT 'CAPTURED' AFTER `raw_payload_sha256`,
  ADD COLUMN `normalized_coverage` VARCHAR(32) NOT NULL DEFAULT 'FULL' AFTER `raw_capture_status`,
  ADD COLUMN `attachment_status` VARCHAR(32) NOT NULL DEFAULT 'NOT_APPLICABLE' AFTER `normalized_coverage`,
  ADD COLUMN `missing_reason` TEXT NULL AFTER `attachment_status`,
  ADD KEY `ix_collected_events_session_sequence` (`session_id`, `sequence`),
  ADD KEY `ix_collected_events_account_kind_occurred` (`account_id`, `kind`, `occurred_at`);

CREATE TABLE `agent_text_segments` (
  `id` VARCHAR(64) NOT NULL,
  `account_id` VARCHAR(64) NOT NULL,
  `collected_event_id` VARCHAR(64) NOT NULL,
  `segment_id` CHAR(64) NOT NULL,
  `ordinal` BIGINT UNSIGNED NOT NULL,
  `format` VARCHAR(32) NOT NULL,
  `purpose` VARCHAR(64) NOT NULL,
  `content_sha256` CHAR(64) NOT NULL,
  `byte_length` BIGINT UNSIGNED NOT NULL,
  `group_sha256` CHAR(64) NOT NULL,
  `group_byte_length` BIGINT UNSIGNED NOT NULL,
  `group_segment_count` BIGINT UNSIGNED NOT NULL,
  `content` LONGTEXT NOT NULL,
  `is_searchable` BOOLEAN NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_agent_text_segments_account_segment` (`account_id`, `segment_id`),
  KEY `ix_agent_text_segments_account_event` (`account_id`, `collected_event_id`),
  UNIQUE KEY `uq_agent_text_segments_event_group_ordinal` (`collected_event_id`, `purpose`, `group_sha256`, `ordinal`),
  FULLTEXT KEY `ft_agent_text_segments_content` (`content`) WITH PARSER ngram,
  CONSTRAINT `fk_agent_text_segments_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_agent_text_segments_event` FOREIGN KEY (`collected_event_id`) REFERENCES `collected_events` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `blob_objects` (
  `id` VARCHAR(64) NOT NULL,
  `account_id` VARCHAR(64) NOT NULL,
  `sha256` CHAR(64) NOT NULL,
  `byte_length` BIGINT UNSIGNED NOT NULL,
  `chunk_size` INT UNSIGNED NOT NULL,
  `chunk_count` BIGINT UNSIGNED NOT NULL,
  `media_type` VARCHAR(255) NOT NULL,
  `filename` TEXT NULL,
  `storage_path` TEXT NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  `failure_reason` TEXT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `completed_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_blob_objects_account_sha256` (`account_id`, `sha256`),
  KEY `ix_blob_objects_account_status` (`account_id`, `status`),
  CONSTRAINT `fk_blob_objects_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `blob_chunks` (
  `blob_object_id` VARCHAR(64) NOT NULL,
  `chunk_index` BIGINT UNSIGNED NOT NULL,
  `byte_length` INT UNSIGNED NOT NULL,
  `sha256` CHAR(64) NOT NULL,
  `storage_path` TEXT NOT NULL,
  `received_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`blob_object_id`, `chunk_index`),
  CONSTRAINT `fk_blob_chunks_object` FOREIGN KEY (`blob_object_id`) REFERENCES `blob_objects` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `event_blob_references` (
  `id` VARCHAR(64) NOT NULL,
  `account_id` VARCHAR(64) NOT NULL,
  `session_id` VARCHAR(64) NOT NULL,
  `collected_event_id` VARCHAR(64) NULL,
  `blob_object_id` VARCHAR(64) NULL,
  `reference_id` CHAR(64) NOT NULL,
  `blob_sha256` CHAR(64) NULL,
  `purpose` VARCHAR(64) NOT NULL,
  `requested_path` TEXT NULL,
  `real_path` TEXT NULL,
  `filename` TEXT NULL,
  `media_type` VARCHAR(255) NULL,
  `byte_length` BIGINT UNSIGNED NULL,
  `captured_at` DATETIME(6) NULL,
  `status` VARCHAR(32) NOT NULL,
  `failure_reason` TEXT NULL,
  `metadata` JSON NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_event_blob_references_account_reference` (`account_id`, `reference_id`),
  KEY `ix_event_blob_references_event` (`collected_event_id`),
  KEY `ix_event_blob_references_session_status` (`session_id`, `status`),
  KEY `ix_event_blob_references_blob_sha` (`account_id`, `blob_sha256`),
  CONSTRAINT `fk_event_blob_references_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_event_blob_references_session` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_event_blob_references_event` FOREIGN KEY (`collected_event_id`) REFERENCES `collected_events` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_event_blob_references_blob` FOREIGN KEY (`blob_object_id`) REFERENCES `blob_objects` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `agent_capture_completeness` (
  `session_id` VARCHAR(64) NOT NULL,
  `account_id` VARCHAR(64) NOT NULL,
  `raw_capture_status` VARCHAR(32) NOT NULL,
  `normalized_coverage` VARCHAR(32) NOT NULL,
  `attachment_status` VARCHAR(32) NOT NULL,
  `event_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `text_segment_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `pending_blob_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `missing_reasons` JSON NOT NULL,
  `assessed_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`session_id`),
  KEY `ix_agent_capture_completeness_account_status` (`account_id`, `raw_capture_status`, `attachment_status`),
  CONSTRAINT `fk_agent_capture_completeness_session` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_agent_capture_completeness_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `collector_backfill_cursors` (
  `id` VARCHAR(64) NOT NULL,
  `account_id` VARCHAR(64) NOT NULL,
  `device_id` VARCHAR(64) NOT NULL,
  `source_type` VARCHAR(32) NOT NULL,
  `source_instance_id` VARCHAR(128) NOT NULL,
  `cursor` JSON NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  `newest_seen_at` DATETIME(6) NULL,
  `oldest_seen_at` DATETIME(6) NULL,
  `last_error` TEXT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_collector_backfill_source` (`account_id`, `device_id`, `source_type`, `source_instance_id`),
  CONSTRAINT `fk_collector_backfill_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_collector_backfill_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
