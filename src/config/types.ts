export type AppConfig = {
  runtime: {
    appName: string;
    timezone: string;
  };
  paths: {
    stateDir: string;
    logsDir: string;
    artifactsDir: string;
    databasePath: string;
    migrationsDir: string;
  };
  eventHub: {
    fallbackScanMs: number;
    defaultLeaseMs: number;
    maxAttempts: number;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
  codex: {
    executable: string;
    model: string | undefined;
    bypassApprovalsAndSandbox: boolean;
    maxToolIterations: number;
  };
  supervisor: {
    logicalName: string;
    handoffTime: string;
  };
  workers: {
    concurrency: number;
  };
  plugins: {
    scheduler: {
      enabled: boolean;
      monitorIntervalMs: number;
      cleanupIntervalMs: number;
      handoffCheckIntervalMs: number;
    };
    wechat: {
      enabled: boolean;
      adapter: "stdout" | "clawbot";
      ownerUserIds: string[];
      clawbotStateDir: string;
      accountId: string | undefined;
      senderConcurrency: number;
    };
  };
  sidecars: {
    maintenance: {
      enabled: boolean;
    };
    monitor: {
      enabled: boolean;
    };
    cleanup: {
      enabled: boolean;
      ackedDeliveryRetentionMs: number;
    };
  };
};

export type LoadedConfig = {
  config: AppConfig;
  configPath: string;
  configExists: boolean;
  projectRoot: string;
};
