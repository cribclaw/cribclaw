export type CribclawIntent =
  | 'log_event'
  | 'query_data'
  | 'edit_event'
  | 'assistant_task'
  | 'unknown';

export type BabyEventType =
  | 'feed'
  | 'diaper'
  | 'sleep_start'
  | 'sleep_end'
  | 'milestone'
  | 'note'
  | 'pump'
  | 'tummy_time'
  | 'solids'
  | 'growth'
  | 'bath';

export interface ExtractedBabyEvent {
  eventType: BabyEventType;
  occurredAt: string;
  summary: string;
  confidence: number;
  attributes: Record<string, string | number | boolean>;
}

export interface LlmConfigUpdate {
  name?: string;
  dob?: string;
  birth_weight?: string;
  timezone?: string;
}

export type LlmAction =
  | { action: 'config_update'; updates: LlmConfigUpdate }
  | { action: 'log_events'; events: ExtractedBabyEvent[] }
  | { action: 'mixed'; config_updates: LlmConfigUpdate; events: ExtractedBabyEvent[] }
  | { action: 'query'; reply: string }
  | { action: 'chat'; reply: string }
  | { action: 'none' };

export interface CribclawResult {
  intent: CribclawIntent;
  reply: string;
  loggedEventId?: number;
  delegateToAgentPrompt?: string;
  attachmentFilePath?: string;
  attachmentCaption?: string;
  attachmentMimeType?: string;
}
