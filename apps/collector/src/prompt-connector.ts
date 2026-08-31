import type { AgentSourceType, SyncEvent } from "@ai-worklog/contracts";

export type PromptSourceType = AgentSourceType;

export interface NormalizedPromptSession {
  sessionId: string;
  events: SyncEvent[];
}

export interface PromptConnector {
  readonly sourceType: PromptSourceType;
  readonly parserVersion: string;
  readonly sourceInstanceId: string;

  readFile(filePath: string): Promise<NormalizedPromptSession>;
}
