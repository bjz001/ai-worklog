import type { Pool } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { listPrompts } from "./query-service";

describe("listPrompts", () => {
  it("pushes filters, counting, and pagination into MySQL", async () => {
    const calls: Array<{
      sql: string;
      values: Array<string | number | Date>;
    }> = [];
    const pool = {
      async execute(sql: string, values: Array<string | number | Date>) {
        calls.push({ sql, values });
        if (sql.includes("SELECT time_zone")) {
          return [[{ time_zone: "Asia/Shanghai" }], []];
        }
        if (sql.includes("COUNT(*)")) {
          return [[{ total: 6_001 }], []];
        }
        return [[{
          id: "prompt-1",
          content: "跨日同步",
          result_content: "已完成",
          project_id: "project-1",
          project_name: "worklog",
          device_id: "device-1",
          device_name: "Mac",
          source_type: "CODEX",
          occurred_at: new Date("2026-07-14T16:30:00.000Z"),
          is_favorite: 0
        }], []];
      }
    } as unknown as Pool;

    const response = await listPrompts({
      pool,
      accountId: "account-1",
      query: {
        page: 2,
        pageSize: 25,
        q: "同步",
        date: "2026-07-15",
        source: "CODEX",
        projectId: "project-1"
      }
    });

    expect(response.pagination).toEqual({
      page: 2,
      pageSize: 25,
      totalItems: 6_001,
      totalPages: 241
    });
    expect(response.data[0]?.workDate).toBe("2026-07-15");
    expect(calls).toHaveLength(3);
    expect(calls[1]?.sql).toContain("COUNT(*)");
    expect(calls[1]?.sql).toContain("pe.occurred_at >= ?");
    expect(calls[1]?.sql).toContain("pe.project_id = ?");
    expect(calls[1]?.values).toContain("project-1");
    expect(calls[1]?.values.slice(-2).map((value) =>
      value instanceof Date ? value.toISOString() : value
    )).toEqual([
      "2026-07-14T16:00:00.000Z",
      "2026-07-15T16:00:00.000Z"
    ]);
    expect(calls[2]?.sql).toContain("ORDER BY pe.occurred_at DESC, pe.id DESC");
    expect(calls[2]?.sql).toContain("LIMIT 25 OFFSET 25");
  });
});
