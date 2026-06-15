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
      `,
    );

    const loaded = loadConfig({ projectRoot, configPath });

    expect(loaded.configExists).toBe(true);
    expect(loaded.config.workers.concurrency).toBe(3);
    expect(loaded.config.codex.model).toBe("gpt-test");
    expect(loaded.config.codex.maxToolIterations).toBe(2);
    expect(loaded.config.paths.databasePath).toBe(join(projectRoot, "state/test.sqlite"));
  });
});
