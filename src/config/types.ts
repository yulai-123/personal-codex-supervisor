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
  supervisor: {
    logicalName: string;
    handoffTime: string;
  };
  workers: {
    concurrency: number;
  };
  plugins: {
    wechat: {
      enabled: boolean;
    };
  };
};

export type LoadedConfig = {
  config: AppConfig;
  configPath: string;
  configExists: boolean;
  projectRoot: string;
};
