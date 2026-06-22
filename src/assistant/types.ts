export type AssistantRuntimeConfig = {
  enabled: boolean;
  configDir: string;
  maxPromptChars: number;
  attention: {
    enabled: boolean;
    intervalMs: number;
    urgentIntervalMs: number;
    maxDailyMessages: number;
    minMinutesBetweenMessages: number;
    unansweredBackoffMs: number;
    quietHours: string[];
  };
};

export type AssistantCapabilityContext = {
  id: string;
  skill: string | null;
  serviceStandards: string | null;
  memory: string | null;
};

export type AssistantPromptContext = {
  enabled: boolean;
  configDir: string;
  persona: string | null;
  profile: string | null;
  capabilities: AssistantCapabilityContext[];
};

export type AssistantSignalStandard = {
  capabilityId: string;
  key: string;
  label: string;
  maxUnknownHours: number;
  naturalWindows: string[];
  priority: number;
  askStyle: string | null;
};

export type AssistantStateStatus = "known" | "unknown" | "stale";
export type AssistantObservationSource =
  | "user_report"
  | "assistant_question"
  | "inferred"
  | "schedule"
  | "tool"
  | "worker"
  | "system";
export type AssistantConfidence = "high" | "medium" | "low";
export type AssistantInterventionAction = "silence" | "record" | "ask" | "remind" | "follow_up" | "task" | "schedule";
export type AssistantInterventionStatus = "planned" | "sent" | "suppressed" | "skipped" | "failed";
