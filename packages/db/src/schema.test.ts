import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  accounts,
  auditLogs,
  collectedEvents,
  dailySummaries,
  deviceTokens,
  devices,
  eventVersions,
  llmSettings,
  periodSummaries,
  periodSummaryEvidence,
  projects,
  promptEntries,
  sessions,
  skillCandidates,
  summaryJobs,
  summaryEvidence,
  syncBatches,
  visibleResults
} from "./schema";

describe("MySQL schema", () => {
  it("exports every MVP table through the Drizzle schema", () => {
    expect(
      [
        accounts,
        devices,
        deviceTokens,
        syncBatches,
        projects,
        sessions,
        collectedEvents,
        eventVersions,
        llmSettings,
        promptEntries,
        visibleResults,
        dailySummaries,
        periodSummaries,
        summaryJobs,
        summaryEvidence,
        periodSummaryEvidence,
        skillCandidates,
        auditLogs
      ].map(getTableName)
    ).toEqual([
      "accounts",
      "devices",
      "device_tokens",
      "sync_batches",
      "projects",
      "sessions",
      "collected_events",
      "event_versions",
      "llm_settings",
      "prompt_entries",
      "visible_results",
      "daily_summaries",
      "period_summaries",
      "summary_jobs",
      "summary_evidence",
      "period_summary_evidence",
      "skill_candidates",
      "audit_logs"
    ]);
  });
});
