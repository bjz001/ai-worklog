import { describe, expect, it } from "vitest";
import {
  bootstrapDatabase,
  closeDatabasePool,
  createDatabaseClient,
  createDatabasePool,
  getDatabase,
  getPool,
  runDemoSeed,
  runMigrations,
  schema
} from "./index";

describe("@ai-worklog/db public API", () => {
  it("exports lazy connection, migration, bootstrap, seed, and schema APIs", () => {
    expect(createDatabasePool).toBeTypeOf("function");
    expect(createDatabaseClient).toBeTypeOf("function");
    expect(getPool).toBeTypeOf("function");
    expect(getDatabase).toBeTypeOf("function");
    expect(closeDatabasePool).toBeTypeOf("function");
    expect(runMigrations).toBeTypeOf("function");
    expect(bootstrapDatabase).toBeTypeOf("function");
    expect(runDemoSeed).toBeTypeOf("function");
    expect(Object.keys(schema)).toHaveLength(24);
    expect(schema.periodSummaries).toBeDefined();
    expect(schema.periodSummaryEvidence).toBeDefined();
    expect(schema.agentTextSegments).toBeDefined();
    expect(schema.blobObjects).toBeDefined();
    expect(schema.blobChunks).toBeDefined();
    expect(schema.eventBlobReferences).toBeDefined();
    expect(schema.agentCaptureCompleteness).toBeDefined();
    expect(schema.collectorBackfillCursors).toBeDefined();
  });
});
