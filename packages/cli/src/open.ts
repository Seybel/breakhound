import { spawn } from 'node:child_process';

/** Opens a file or URL with the system's default app. */
export function openInDefaultApp(target: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['cmd', ['/d', '/s', '/c', `start "" "${target}"`]]
        : ['xdg-open', [target]];
  const child = spawn(cmd, args, {
    stdio: 'ignore',
    detached: true,
    // cmd.exe parses its own command line; Node's quoting would double up ours.
    windowsVerbatimArguments: process.platform === 'win32',
  });
  child.on('error', () => {});
  child.unref();
}
