import type { HubMessage } from "./types.js";
import { isRecord } from "../../shared/json.js";

export type EventRouter = {
  route(message: HubMessage): string[];
};

export class DefaultEventRouter implements EventRouter {
  route(message: HubMessage): string[] {
    const groups = new Set<string>(["projection_group"]);

    if (message.kind === "command" && message.type.startsWith("command.task.")) {
      groups.add("worker_group");
    }

    if (message.kind === "command" && message.type === "command.message.send_wechat") {
      groups.add("wechat_sender_group");
    }

    if (message.type === "event.wechat.message_received") {
      groups.add("supervisor_group");
    }

    if (message.type === "event.system.alert") {
      groups.add("supervisor_group");
      groups.add("monitor_group");
    }

    if (message.type === "event.message.send_failed") {
      groups.add("supervisor_group");
    }

    if (message.type === "event.maintenance.handoff_required") {
      groups.add("supervisor_group");
      groups.add("maintenance_group");
    }

    if (message.type.startsWith("command.maintenance.") || message.type.startsWith("event.maintenance.")) {
      groups.add("maintenance_group");
    }

    if (message.type.startsWith("command.monitor.") || message.type.startsWith("event.monitor.")) {
      groups.add("monitor_group");
    }

    if (message.type === "event.task.failed" || message.type === "event.task.needs_decision") {
      groups.add("supervisor_group");
    }

    if (message.type === "event.task.completed" && shouldSupervisorSeeTaskCompletion(message.payload)) {
      groups.add("supervisor_group");
    }

    return [...groups];
  }
}

export const defaultEventRouter = new DefaultEventRouter();

export function inferTopic(type: string): string {
  const parts = type.split(".");
  return parts.length >= 2 && parts[1] ? parts[1] : "default";
}

function shouldSupervisorSeeTaskCompletion(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return true;
  }
  const shouldNotify = payload.shouldNotifyUser ?? payload.should_notify_user;
  const needsDecision = payload.needsSupervisorDecision ?? payload.needs_supervisor_decision;

  return shouldNotify === "yes" || shouldNotify === "uncertain" || needsDecision === true || needsDecision === 1;
}
