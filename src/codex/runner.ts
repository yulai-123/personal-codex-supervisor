import { spawn } from "node:child_process";
import { AppError } from "../shared/errors.js";
import { parseCodexJsonl, summarizeCodexEvents, type CodexRunSummary } from "./output-parser.js";

export type CodexTurnInput = {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  env?: Record<string, string | undefined>;
};

export type CodexRunner = {
  runTurn(input: CodexTurnInput): Promise<CodexRunSummary>;
};

export type CliCodexRunnerOptions = {
  executable?: string;
  baseEnv?: NodeJS.ProcessEnv;
  bypassApprovalsAndSandbox?: boolean;
};

export class CliCodexRunner implements CodexRunner {
  private readonly executable: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly bypassApprovalsAndSandbox: boolean;

  constructor(options: CliCodexRunnerOptions = {}) {
    this.executable = options.executable ?? "codex";
    this.baseEnv = options.baseEnv ?? process.env;
    this.bypassApprovalsAndSandbox = options.bypassApprovalsAndSandbox ?? true;
  }

  async runTurn(input: CodexTurnInput): Promise<CodexRunSummary> {
    const args = input.sessionId
      ? ["exec", "resume", "--json", input.sessionId, "-"]
      : ["exec", "--json", "-C", input.cwd, "-"];

    if (this.bypassApprovalsAndSandbox) {
      const insertAt = input.sessionId ? 3 : 2;
      args.splice(insertAt, 0, "--dangerously-bypass-approvals-and-sandbox");
    }

    if (input.model) {
      const insertAt = input.sessionId ? (this.bypassApprovalsAndSandbox ? 4 : 3) : (this.bypassApprovalsAndSandbox ? 3 : 2);
      args.splice(insertAt, 0, "--model", input.model);
    }

    const { stdout, stderr, exitCode } = await spawnCodex(this.executable, args, {
      cwd: input.cwd,
      env: {
        ...this.baseEnv,
        ...input.env,
      },
      stdin: input.prompt,
    });

    if (exitCode !== 0) {
      throw new AppError(
        `Codex exited with code ${exitCode}: ${stderr.trim() || "no stderr"}`,
        "CODEX_RUN_FAILED",
      );
    }

    try {
      return summarizeCodexEvents(parseCodexJsonl(stdout));
    } catch (error) {
      throw new AppError("Failed to parse Codex JSONL output", "CODEX_OUTPUT_PARSE_FAILED", error);
    }
  }
}

type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

function spawnCodex(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin: string;
  },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });

    child.stdin.end(options.stdin);
  });
}
