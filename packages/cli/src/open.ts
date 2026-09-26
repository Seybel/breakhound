import { spawn } from 'node:child_process';

/** Opens a file or URL with the system's default app. */
export function openInDefaultApp(target: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', target]]
        : ['xdg-open', [target]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}
