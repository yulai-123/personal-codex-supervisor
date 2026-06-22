import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { AppConfig, LoadedConfig } from "./types.js";

const configSchema = z.object({
  runtime: z.object({
    appName: z.string().min(1),
    timezone: z.string().min(1),
  }),
  paths: z.object({
    stateDir: z.string().min(1),
    logsDir: z.string().min(1),
    artifactsDir: z.string().min(1),
    databasePath: z.string().min(1),
    migrationsDir: z.string().min(1),
  }),
  eventHub: z.object({
    fallbackScanMs: z.number().int().positive(),
    defaultLeaseMs: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
  }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]),
  }),
  codex: z.object({
    executable: z.string().min(1),
    model: z.string().min(1).optional(),
    bypassApprovalsAndSandbox: z.boolean(),
    maxToolIterations: z.number().int().nonnegative(),
  }),
  supervisor: z.object({
    logicalName: z.string().min(1),
    handoffTime: z.string().regex(/^\d{2}:\d{2}$/),
  }),
  workers: z.object({
    concurrency: z.number().int().positive(),
  }),
  assistant: z.object({
    enabled: z.boolean(),
    configDir: z.string().min(1),
    maxPromptChars: z.number().int().positive(),
    attention: z.object({
      enabled: z.boolean(),
      intervalMs: z.number().int().positive(),
      urgentIntervalMs: z.number().int().positive(),
      maxDailyMessages: z.number().int().positive(),
      minMinutesBetweenMessages: z.number().int().nonnegative(),
      unansweredBackoffMs: z.number().int().nonnegative(),
      quietHours: z.array(z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)),
    }),
  }),
  plugins: z.object({
    scheduler: z.object({
      enabled: z.boolean(),
      monitorIntervalMs: z.number().int().positive(),
      cleanupIntervalMs: z.number().int().positive(),
      handoffCheckIntervalMs: z.number().int().positive(),
    }),
    wechat: z.object({
      enabled: z.boolean(),
      adapter: z.enum(["stdout", "clawbot"]),
      ownerUserIds: z.array(z.string().min(1)),
      clawbotStateDir: z.string().min(1),
      accountId: z.string().min(1).optional(),
      senderConcurrency: z.number().int().positive(),
    }),
  }),
  sidecars: z.object({
    maintenance: z.object({
      enabled: z.boolean(),
    }),
    monitor: z.object({
      enabled: z.boolean(),
    }),
    cleanup: z.object({
      enabled: z.boolean(),
      ackedDeliveryRetentionMs: z.number().int().positive(),
    }),
  }),
}).superRefine((config, ctx) => {
  if (config.plugins.wechat.enabled && config.plugins.wechat.ownerUserIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["plugins", "wechat", "ownerUserIds"],
      message: "plugins.wechat.owner_user_ids must contain at least one owner when WeChat is enabled",
    });
  }
});

const defaultConfig: AppConfig = {
  runtime: {
    appName: "personal-codex-supervisor",
    timezone: "UTC",
  },
  paths: {
    stateDir: "local-only/state",
    logsDir: "local-only/logs",
    artifactsDir: "local-only/artifacts",
    databasePath: "local-only/state/app.sqlite",
    migrationsDir: "migrations",
  },
  eventHub: {
    fallbackScanMs: 30_000,
    defaultLeaseMs: 300_000,
    maxAttempts: 5,
  },
  logging: {
    level: "info",
  },
  codex: {
    executable: "codex",
    model: undefined,
    bypassApprovalsAndSandbox: true,
    maxToolIterations: 4,
  },
  supervisor: {
    logicalName: "wechat_main",
    handoffTime: "02:00",
  },
  workers: {
    concurrency: 5,
  },
  assistant: {
    enabled: false,
    configDir: "local-only/assistant",
    maxPromptChars: 12_000,
    attention: {
      enabled: false,
      intervalMs: 30 * 60 * 1_000,
      urgentIntervalMs: 15 * 60 * 1_000,
      maxDailyMessages: 5,
      minMinutesBetweenMessages: 60,
      unansweredBackoffMs: 2 * 60 * 60 * 1_000,
      quietHours: ["00:30-08:30"],
    },
  },
  plugins: {
    scheduler: {
      enabled: true,
      monitorIntervalMs: 60_000,
      cleanupIntervalMs: 3_600_000,
      handoffCheckIntervalMs: 60_000,
    },
    wechat: {
      enabled: false,
      adapter: "stdout",
      ownerUserIds: [],
      clawbotStateDir: "local-only/wechat-clawbot",
      accountId: undefined,
      senderConcurrency: 1,
    },
  },
  sidecars: {
    maintenance: {
      enabled: true,
    },
    monitor: {
      enabled: true,
    },
    cleanup: {
      enabled: true,
      ackedDeliveryRetentionMs: 7 * 24 * 60 * 60 * 1_000,
    },
  },
};

export type LoadConfigOptions = {
  projectRoot?: string;
  configPath?: string;
};

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const configuredPath =
    options.configPath ?? process.env.PCS_CONFIG ?? "local-only/config.toml";
  const configPath = resolve(projectRoot, configuredPath);
  const configExists = existsSync(configPath);
  const fileConfig = configExists
    ? normalizeKeys(parseToml(readFileSync(configPath, "utf8")))
    : {};
  const merged = mergeDeep(defaultConfig, fileConfig);
  const parsedRaw = configSchema.parse(merged);
  const parsed: AppConfig = {
    ...parsedRaw,
    codex: {
      ...parsedRaw.codex,
      model: parsedRaw.codex.model,
    },
    plugins: {
      ...parsedRaw.plugins,
      wechat: {
        ...parsedRaw.plugins.wechat,
        accountId: parsedRaw.plugins.wechat.accountId,
      },
    },
  };

  return {
    config: resolveConfigPaths(parsed, projectRoot),
    configPath,
    configExists,
    projectRoot,
  };
}

function resolveConfigPaths(config: AppConfig, projectRoot: string): AppConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      wechat: {
        ...config.plugins.wechat,
        clawbotStateDir: resolve(projectRoot, config.plugins.wechat.clawbotStateDir),
        accountId: config.plugins.wechat.accountId,
      },
    },
    assistant: {
      ...config.assistant,
      configDir: resolve(projectRoot, config.assistant.configDir),
      attention: {
        ...config.assistant.attention,
        quietHours: [...config.assistant.attention.quietHours],
      },
    },
    paths: {
      stateDir: resolve(projectRoot, config.paths.stateDir),
      logsDir: resolve(projectRoot, config.paths.logsDir),
      artifactsDir: resolve(projectRoot, config.paths.artifactsDir),
      databasePath: resolve(projectRoot, config.paths.databasePath),
      migrationsDir: resolve(projectRoot, config.paths.migrationsDir),
    },
  };
}

function mergeDeep(base: unknown, override: unknown): unknown {
  if (!isPlainRecord(base) || !isPlainRecord(override)) {
    return override === undefined ? base : override;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = mergeDeep(result[key], value);
  }
  return result;
}

function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeKeys);
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[toCamelCase(key)] = normalizeKeys(item);
  }
  return result;
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
