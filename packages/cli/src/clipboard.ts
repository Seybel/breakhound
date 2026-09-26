import { spawnSync } from 'node:child_process';

/** Copies text with the OS clipboard tool. Returns false when none is available. */
export function copyToClipboard(text: string): boolean {
  const candidates: [string, string[]][] =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];
  for (const [cmd, args] of candidates) {
    const run = spawnSync(cmd, args, { input: text });
    if (!run.error && run.status === 0) return true;
  }
  return false;
}
