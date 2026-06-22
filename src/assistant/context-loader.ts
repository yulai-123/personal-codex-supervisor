import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { AssistantCapabilityContext, AssistantPromptContext, AssistantRuntimeConfig, AssistantSignalStandard } from "./types.js";

export function loadAssistantPromptContext(config: AssistantRuntimeConfig): AssistantPromptContext {
  if (!config.enabled || !existsSync(config.configDir)) {
    return {
      enabled: false,
      configDir: config.configDir,
      persona: null,
      profile: null,
      capabilities: [],
    };
  }

  return {
    enabled: true,
    configDir: config.configDir,
    persona: readTextIfExists(join(config.configDir, "persona.md"), config.maxPromptChars),
    profile: readTextIfExists(join(config.configDir, "profile.md"), config.maxPromptChars),
    capabilities: loadCapabilities(config),
  };
}

export function loadAssistantSignalStandards(config: AssistantRuntimeConfig): AssistantSignalStandard[] {
  if (!config.enabled || !existsSync(config.configDir)) {
    return [];
  }

  const capabilitiesDir = join(config.configDir, "capabilities");
  if (!existsSync(capabilitiesDir)) {
    return [];
  }

  const standards: AssistantSignalStandard[] = [];
  for (const capabilityId of readdirSync(capabilitiesDir).sort()) {
    const capabilityDir = join(capabilitiesDir, capabilityId);
    const standardsPath = join(capabilityDir, "service-standards.toml");
    if (!existsSync(standardsPath)) {
      continue;
    }
    const parsed = parseToml(readFileSync(standardsPath, "utf8")) as Record<string, unknown>;
    const signals = Array.isArray(parsed.signals) ? parsed.signals : [];
    for (const item of signals) {
      const signal = normalizeSignal(capabilityId, item);
      if (signal) {
        standards.push(signal);
      }
    }
  }
  return standards.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
}

function loadCapabilities(config: AssistantRuntimeConfig): AssistantCapabilityContext[] {
  const capabilitiesDir = join(config.configDir, "capabilities");
  if (!existsSync(capabilitiesDir)) {
    return [];
  }

  return readdirSync(capabilitiesDir)
    .sort()
    .map((capabilityId) => {
      const capabilityDir = join(capabilitiesDir, capabilityId);
      return {
        id: capabilityId,
        skill: readTextIfExists(join(capabilityDir, "SKILL.md"), config.maxPromptChars),
        serviceStandards: readTextIfExists(join(capabilityDir, "service-standards.toml"), config.maxPromptChars),
        memory: readCapabilityMemory(capabilityDir, config.maxPromptChars),
      };
    })
    .filter((item) => item.skill || item.serviceStandards || item.memory);
}

function readCapabilityMemory(capabilityDir: string, maxChars: number): string | null {
  const memoryFiles: Array<[string, string]> = [
    ["memory.md", "Manual memory"],
    ["memory.generated.md", "Generated memory"],
  ];
  const parts = memoryFiles.flatMap(([fileName, label]) => {
    const text = readTextIfExists(join(capabilityDir, fileName), maxChars);
    return text ? [`## ${label}\n\n${text}`] : [];
  });
  if (parts.length === 0) {
    return null;
  }
  const text = parts.join("\n\n");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[assistant memory truncated at ${maxChars} chars]`;
}

function readTextIfExists(path: string, maxChars: number): string | null {
  if (!existsSync(path)) {
    return null;
  }
  const text = readFileSync(path, "utf8");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[assistant context truncated at ${maxChars} chars]`;
}

function normalizeSignal(capabilityId: string, value: unknown): AssistantSignalStandard | null {
  if (!isRecord(value)) {
    return null;
  }

  const key = getString(value, "key");
  if (!key) {
    return null;
  }

  return {
    capabilityId,
    key,
    label: getString(value, "label") ?? key,
    maxUnknownHours: getPositiveNumber(value, "maxUnknownHours") ?? getPositiveNumber(value, "max_unknown_hours") ?? 24,
    naturalWindows: getStringArray(value, "naturalWindows") ?? getStringArray(value, "natural_windows") ?? [],
    priority: Math.round(getPositiveNumber(value, "priority") ?? 300),
    askStyle: getString(value, "askStyle") ?? getString(value, "ask_style") ?? null,
  };
}

function getString(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" && item.trim() ? item : undefined;
}

function getPositiveNumber(value: Record<string, unknown>, key: string): number | undefined {
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item) && item > 0 ? item : undefined;
}

function getStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  const item = value[key];
  if (!Array.isArray(item)) {
    return undefined;
  }
  return item.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
