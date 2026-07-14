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
        promptEntries,
        visibleResults,
        dailySummaries,
        summaryJobs,
        summaryEvidence,
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
      "prompt_entries",
      "visible_results",
      "daily_summaries",
      "summary_jobs",
      "summary_evidence",
      "skill_candidates",
      "audit_logs"
    ]);
  });
});
