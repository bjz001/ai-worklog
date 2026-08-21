ALTER TABLE `llm_settings`
  ADD COLUMN `daily_summary_prompt` TEXT NULL AFTER `encrypted_api_key`,
  ADD COLUMN `weekly_summary_prompt` TEXT NULL AFTER `daily_summary_prompt`,
  ADD COLUMN `monthly_summary_prompt` TEXT NULL AFTER `weekly_summary_prompt`,
  ADD CONSTRAINT `chk_llm_settings_daily_summary_prompt`
    CHECK (`daily_summary_prompt` IS NULL OR OCTET_LENGTH(`daily_summary_prompt`) BETWEEN 1 AND 4096),
  ADD CONSTRAINT `chk_llm_settings_weekly_summary_prompt`
    CHECK (`weekly_summary_prompt` IS NULL OR OCTET_LENGTH(`weekly_summary_prompt`) BETWEEN 1 AND 4096),
  ADD CONSTRAINT `chk_llm_settings_monthly_summary_prompt`
    CHECK (`monthly_summary_prompt` IS NULL OR OCTET_LENGTH(`monthly_summary_prompt`) BETWEEN 1 AND 4096);
