import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface AuditEvent {
  timestamp: string;
  runId: string;
  project: string;
  parentTicket: number;
  phase: string;
  operation: string;
  target: string;
  attempt: number;
  result: string | null;
  error: string | null;
  agentAttemptId?: string;
  diagnosticLogPath?: string;
  transition?: string;
  diagnostics?: object;
}

export class AuditLog {
  readonly path: string;
  private readonly secrets: readonly string[];

  constructor(
    projectDirectory: string,
    timestamp: string,
    parentTicket: number,
    runId: string,
    secrets: readonly string[] = [],
  ) {
    this.secrets = secrets;
    const safeTimestamp = timestamp.replaceAll(":", "-");
    this.path = path.join(
      projectDirectory,
      "logs",
      `${safeTimestamp}-parent-${parentTicket}-${runId}.jsonl`,
    );
  }

  async create(): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true });
    await appendFile(this.path, "");
  }

  async append(event: AuditEvent): Promise<void> {
    const json = JSON.stringify(event, (_key, value: unknown) => {
      if (typeof value !== "string") return value;
      let sanitized = value;
      for (const secret of this.secrets)
        if (secret) sanitized = sanitized.replaceAll(secret, "[redacted]");
      return sanitized;
    });
    await appendFile(this.path, `${json}\n`);
  }
}
