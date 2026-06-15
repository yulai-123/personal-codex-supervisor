export type HubKind = "command" | "event";

export type DeliveryStatus = "pending" | "running" | "acked" | "failed" | "dead_letter";

export type HubMessage = {
  id: string;
  kind: HubKind;
  type: string;
  topic: string;
  source: string;
  priority: number;
  payload: unknown;
  correlationId: string;
  causationId?: string;
  dedupeKey?: string;
  scheduledAt?: string;
  createdAt: string;
};

export type AppendHubMessageInput = {
  kind: HubKind;
  type: string;
  topic?: string;
  source: string;
  priority?: number;
  payload?: unknown;
  correlationId?: string;
  causationId?: string;
  dedupeKey?: string;
  scheduledAt?: string;
};

export type AppendHubMessageResult = {
  message: HubMessage;
  deliveryGroupIds: string[];
  duplicate: boolean;
};

export type EventDelivery = {
  id: string;
  messageId: string;
  groupId: string;
  status: DeliveryStatus;
  priority: number;
  availableAt: string;
  leaseUntil?: string;
  attempts: number;
  lockedBy?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type ClaimedDelivery = {
  delivery: EventDelivery;
  message: HubMessage;
};

export type ConsumerHandler = (delivery: ClaimedDelivery) => Promise<void> | void;
