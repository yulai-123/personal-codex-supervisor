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
  plugins: z.object({
    wechat: z.object({
      enabled: z.boolean(),
    }),
  }),
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
  plugins: {
    wechat: {
      enabled: false,
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
