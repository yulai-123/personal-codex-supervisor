import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load-config.js";

describe("loadConfig", () => {
  it("uses safe defaults when local config is absent", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pcs-config-default-"));
    const loaded = loadConfig({ projectRoot });

    expect(loaded.configExists).toBe(false);
    expect(loaded.config.workers.concurrency).toBe(5);
    expect(loaded.config.codex).toMatchObject({
      executable: "codex",
      bypassApprovalsAndSandbox: true,
      maxToolIterations: 4,
    });
    expect(loaded.config.logging.level).toBe("info");
    expect(loaded.config.plugins.scheduler.enabled).toBe(true);
    expect(loaded.config.plugins.wechat.enabled).toBe(false);
    expect(loaded.config.plugins.wechat.ownerUserIds).toEqual([]);
    expect(loaded.config.plugins.wechat.clawbotStateDir).toBe(join(projectRoot, "local-only/wechat-clawbot"));
    expect(loaded.config.assistant.enabled).toBe(false);
    expect(loaded.config.assistant.configDir).toBe(join(projectRoot, "local-only/assistant"));
    expect(loaded.config.assistant.attention.intervalMs).toBe(1_800_000);
    expect(loaded.config.sidecars.cleanup.ackedDeliveryRetentionMs).toBe(604_800_000);
    expect(loaded.config.paths.databasePath).toBe(join(projectRoot, "local-only/state/app.sqlite"));
  });

  it("loads TOML config and normalizes snake_case keys", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pcs-config-file-"));
    const configPath = join(projectRoot, "config.toml");
    writeFileSync(
      configPath,
      `
        [paths]
        database_path = "state/test.sqlite"

        [workers]
        concurrency = 3

        [codex]
        model = "gpt-test"
        max_tool_iterations = 2

        [plugins.scheduler]
        monitor_interval_ms = 1000

        [assistant]
        enabled = true
        config_dir = "assistant-private"

        [assistant.attention]
        enabled = true
        interval_ms = 900000
        quiet_hours = ["01:00-07:30"]

        [plugins.wechat]
        adapter = "clawbot"
        owner_user_ids = ["owner-test"]
        clawbot_state_dir = "wechat-state"

        [sidecars.cleanup]
        acked_delivery_retention_ms = 1000
      `,
    );

    const loaded = loadConfig({ projectRoot, configPath });

    expect(loaded.configExists).toBe(true);
    expect(loaded.config.workers.concurrency).toBe(3);
    expect(loaded.config.codex.model).toBe("gpt-test");
    expect(loaded.config.codex.maxToolIterations).toBe(2);
    expect(loaded.config.plugins.scheduler.monitorIntervalMs).toBe(1000);
    expect(loaded.config.assistant.enabled).toBe(true);
    expect(loaded.config.assistant.configDir).toBe(join(projectRoot, "assistant-private"));
    expect(loaded.config.assistant.attention.enabled).toBe(true);
    expect(loaded.config.assistant.attention.intervalMs).toBe(900_000);
    expect(loaded.config.assistant.attention.quietHours).toEqual(["01:00-07:30"]);
    expect(loaded.config.plugins.wechat.adapter).toBe("clawbot");
    expect(loaded.config.plugins.wechat.ownerUserIds).toEqual(["owner-test"]);
    expect(loaded.config.plugins.wechat.clawbotStateDir).toBe(join(projectRoot, "wechat-state"));
    expect(loaded.config.sidecars.cleanup.ackedDeliveryRetentionMs).toBe(1000);
    expect(loaded.config.paths.databasePath).toBe(join(projectRoot, "state/test.sqlite"));
  });

  it("requires owner ids when WeChat is enabled", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pcs-config-wechat-"));
    const configPath = join(projectRoot, "config.toml");
    writeFileSync(
      configPath,
      `
        [plugins.wechat]
        enabled = true
      `,
    );

    expect(() => loadConfig({ projectRoot, configPath })).toThrow(/owner_user_ids/);
  });
});
