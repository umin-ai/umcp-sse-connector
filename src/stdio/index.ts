// stdio-client-transport.ts

import { spawn, ChildProcessWithoutNullStreams } from "child_process";

export class StdIOClientTransport {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private listeners: Array<(msg: any) => void> = [];

  constructor(
    command: string,
    args: string[] = [],
    env: Record<string,string> = {}
  ) {
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],  // ← stderr is now a pipe, not null
      env: { ...process.env, ...env },
      cwd: process.cwd()
    });

    // (optional) log stderr for debugging:
    this.proc.stderr.on("data", chunk => {
      console.error(`[${command} stderr] ${chunk.toString()}`);
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", chunk => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) {
          try {
            const msg = JSON.parse(line);
            this.listeners.forEach(fn => fn(msg));
          } catch {
            // ignore malformed JSON
          }
        }
      }
    });
  }

  async send(message: any): Promise<void> {
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }

  onMessage(fn: (msg: any) => void): void {
    this.listeners.push(fn);
  }

  async close(): Promise<void> {
    this.proc.kill();
  }
}
