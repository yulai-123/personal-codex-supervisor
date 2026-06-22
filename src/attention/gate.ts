import type { AppDatabase } from "../storage/sqlite.js";

export type AttentionGateInput = {
  capabilityId: string;
  priority: number;
  now: Date;
  timezone: string;
  maxDailyMessages: number;
  minMinutesBetweenMessages: number;
  unansweredBackoffMs: number;
  quietHours: string[];
};

export type AttentionGateResult = {
  allowed: boolean;
  reason: string;
};

export function evaluateAttentionGate(db: AppDatabase, input: AttentionGateInput): AttentionGateResult {
  if (isInQuietHours(input.now, input.timezone, input.quietHours) && input.priority >= 100) {
    return { allowed: false, reason: "quiet_hours" };
  }

  const dailySent = countDailySentInterventions(db, input.now, input.timezone);
  if (dailySent >= input.maxDailyMessages && input.priority >= 50) {
    return { allowed: false, reason: "daily_message_budget_exhausted" };
  }

  const lastSent = getLastSentIntervention(db, input.capabilityId);
  if (lastSent) {
    const lastSentAt = new Date(lastSent.created_at);
    const minutesSinceLast = (input.now.getTime() - lastSentAt.getTime()) / 60_000;
    if (minutesSinceLast < input.minMinutesBetweenMessages && input.priority >= 50) {
      return { allowed: false, reason: "message_cooldown" };
    }

    if (!hasInboundAfter(db, lastSent.created_at)) {
      const msSinceLast = input.now.getTime() - lastSentAt.getTime();
      if (msSinceLast < input.unansweredBackoffMs && input.priority >= 50) {
        return { allowed: false, reason: "unanswered_backoff" };
      }
    }
  }

  return { allowed: true, reason: "allowed" };
}

export function isWithinNaturalWindow(now: Date, timezone: string, windows: string[]): boolean {
  if (windows.length === 0) {
    return true;
  }
  const minutes = localMinutesSinceMidnight(now, timezone);
  return windows.some((window) => isMinuteInWindow(minutes, window));
}

export function isInQuietHours(now: Date, timezone: string, windows: string[]): boolean {
  const minutes = localMinutesSinceMidnight(now, timezone);
  return windows.some((window) => isMinuteInWindow(minutes, window));
}

function countDailySentInterventions(db: AppDatabase, now: Date, timezone: string): number {
  const localDate = localDateText(now, timezone);
  const rows = db.prepare(`
    SELECT created_at
    FROM assistant_interventions
    WHERE status = 'sent'
    ORDER BY created_at DESC
    LIMIT 200
  `).all() as Array<{ created_at: string }>;
  return rows.filter((row) => localDateText(new Date(row.created_at), timezone) === localDate).length;
}

function getLastSentIntervention(db: AppDatabase, capabilityId: string): { created_at: string } | null {
  return db.prepare(`
    SELECT created_at
    FROM assistant_interventions
    WHERE capability_id = ?
      AND status = 'sent'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(capabilityId) as { created_at: string } | undefined ?? null;
}

function hasInboundAfter(db: AppDatabase, createdAt: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS present
    FROM event_log
    WHERE type IN ('event.wechat.message_received', 'event.user.message_received')
      AND source != 'scheduler'
      AND created_at > ?
    LIMIT 1
  `).get(createdAt) as { present: number } | undefined;
  return !!row;
}

function localDateText(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function localMinutesSinceMidnight(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  return Number(get("hour")) * 60 + Number(get("minute"));
}

function isMinuteInWindow(minutes: number, window: string): boolean {
  const [startText, endText] = window.split("-");
  const start = parseHourMinute(startText ?? "00:00");
  const end = parseHourMinute(endText ?? "00:00");
  if (start <= end) {
    return minutes >= start && minutes <= end;
  }
  return minutes >= start || minutes <= end;
}

function parseHourMinute(value: string): number {
  const [hourText, minuteText] = value.split(":");
  return Number(hourText) * 60 + Number(minuteText);
}
