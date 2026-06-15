import { createHash } from "node:crypto";

export type WechatOwnerPolicy = {
  ownerUserIds: readonly string[];
};

export type RedactedWechatId = {
  hash: string;
  suffix?: string;
};

export function normalizeWechatId(value: string): string {
  return value.trim();
}

export function isAuthorizedWechatId(policy: WechatOwnerPolicy, candidate: string): boolean {
  const normalizedCandidate = normalizeWechatId(candidate);
  if (!normalizedCandidate) {
    return false;
  }

  return policy.ownerUserIds
    .map(normalizeWechatId)
    .filter((item) => item.length > 0)
    .includes(normalizedCandidate);
}

export function redactWechatId(value: string): RedactedWechatId {
  const normalized = normalizeWechatId(value);
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  const suffix = normalized.length > 4 ? normalized.slice(-4) : undefined;
  return {
    hash,
    ...(suffix ? { suffix } : {}),
  };
}
