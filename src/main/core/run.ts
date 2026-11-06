// Running external programs. Always execFile with an argument array, never a
// shell string, so quoting behaves the same on macOS, Linux and Windows.
import { execFile } from "node:child_process";

export class CommandError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

export function run(file: string, args: string[], cwd?: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) };
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr).trim() || err.message;
        reject(new CommandError(`${file} ${args.join(" ")}: ${detail}`, String(stderr)));
      } else {
        resolve(String(stdout));
      }
    });
  });
}

export const git = (cwd: string, ...args: string[]) => run("git", args, cwd).then((s) => s.trim());
