import { z } from "zod";

export const workerTaskEventSchema = z.object({
  status: z.enum(["success", "warning", "error", "needs_decision", "cancelled", "timed_out"]),
  severity: z.enum(["debug", "info", "notice", "warning", "error", "critical"]).default("info"),
  summary: z.string().min(1),
  details: z.string().optional(),
  userImpact: z.string().optional(),
  recommendedAction: z.string().optional(),
  shouldNotifyUser: z.enum(["yes", "no", "uncertain"]).default("uncertain"),
  needsSupervisorDecision: z.boolean().default(false),
  artifacts: z.array(z.record(z.string(), z.unknown())).default([]),
});

export type WorkerTaskEvent = z.infer<typeof workerTaskEventSchema>;

export function parseWorkerTaskEvent(message: string): WorkerTaskEvent {
  const candidates = candidateJsonTexts(message);
  for (const candidate of candidates) {
    try {
      return workerTaskEventSchema.parse(JSON.parse(candidate) as unknown);
    } catch {
      continue;
    }
  }

  return {
    status: "warning",
    severity: "warning",
    summary: message.trim() || "Worker finished without a structured task event.",
    shouldNotifyUser: "uncertain",
    needsSupervisorDecision: true,
    artifacts: [],
  };
}

export function formatWorkerFinalOutputInstructions(): string {
  return `Final output must be JSON only and match this shape:

{
  "status": "success | warning | error | needs_decision | cancelled | timed_out",
  "severity": "debug | info | notice | warning | error | critical",
  "summary": "short factual summary for the supervisor",
  "details": "optional details",
  "userImpact": "optional user impact",
  "recommendedAction": "optional recommendation for the supervisor",
  "shouldNotifyUser": "yes | no | uncertain",
  "needsSupervisorDecision": false,
  "artifacts": []
}`;
}

function candidateJsonTexts(message: string): string[] {
  const trimmed = message.trim();
  const candidates = [trimmed];
  const fences = message.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const fence of fences) {
    if (fence[1]) {
      candidates.push(fence[1].trim());
    }
  }
  return candidates;
}
