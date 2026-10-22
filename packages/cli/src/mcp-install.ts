import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';

/**
 * Adds breakhound's MCP server to the coding agents found on this machine.
 * Project-level files (Claude Code, Cursor, VS Code, Antigravity) are preferred,
 * so the whole team gets it; Windsurf and Codex only have a config in your home
 * folder. Nothing is written before you've seen the change and said yes.
 */

export type ClientId = 'claude' | 'cursor' | 'vscode' | 'antigravity' | 'windsurf' | 'codex';

export interface Client {
  id: ClientId;
  name: string;
  file: string;
  /** How the entry is added to the file's current contents; null when it's already there. */
  update(current: string | null): string | null;
}

const SERVER_NAME = 'breakhound';
const PACKAGE = '@seybel/breakhound';

/**
 * An entry that starts the unscoped `breakhound` package from npm, which is someone else's
 * tool: written by an early build of this one, it's replaced rather than left in place.
 */
function startsOtherPackage(args: unknown): boolean {
  return Array.isArray(args) && args.includes('breakhound') && !args.includes(PACKAGE);
}

/** npx uses the project's own breakhound when it's installed, the latest otherwise. */
export function serverCommand(platform = process.platform): { command: string; args: string[] } {
  const args = ['-y', PACKAGE, 'mcp'];
  // Windows can't start npx (a .cmd file) directly.
  return platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'npx', ...args] }
    : { command: 'npx', args };
}

function jsonClient(
  id: ClientId,
  name: string,
  file: string,
  key: 'mcpServers' | 'servers',
  entry: Record<string, unknown>,
): Client {
  return {
    id,
    name,
    file,
    update(current) {
      let data: Record<string, Record<string, unknown>> = {};
      if (current?.trim()) {
        try {
          data = JSON.parse(current);
        } catch {
          throw new Error(
            `${file} isn't plain JSON (it may have comments), so it's left alone. Add this under "${key}":\n${JSON.stringify({ [SERVER_NAME]: entry }, null, 2)}`,
          );
        }
      }
      const existing = data[key]?.[SERVER_NAME] as { args?: unknown } | undefined;
      if (existing && !startsOtherPackage(existing.args)) return null;
      data[key] = { ...data[key], [SERVER_NAME]: entry };
      return `${JSON.stringify(data, null, 2)}\n`;
    },
  };
}

function codexClient(file: string): Client {
  return {
    id: 'codex',
    name: 'Codex',
    file,
    update(current) {
      const { command, args } = serverCommand();
      const block = `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args).replaceAll(',', ', ')}\n`;
      // The table runs to the next table header or the end of the file.
      const table = /^\[mcp_servers\.breakhound\]\n(?:(?!\[)[^\n]*\n?)*/m;
      const found = current?.match(table)?.[0];
      if (found) {
        if (found.includes(PACKAGE) || !/["']breakhound["']/.test(found)) return null;
        return (current as string).replace(table, `${block}${found.endsWith('\n\n') ? '\n' : ''}`);
      }
      const before = current ?? '';
      return `${before}${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${block}`;
    },
  };
}

function onPath(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0;
}

/** Every client breakhound knows how to set up, for this project. */
export function allClients(cwd: string, home = homedir()): Client[] {
  const { command, args } = serverCommand();
  return [
    jsonClient('claude', 'Claude Code', join(cwd, '.mcp.json'), 'mcpServers', { command, args }),
    jsonClient('cursor', 'Cursor', join(cwd, '.cursor', 'mcp.json'), 'mcpServers', {
      command,
      args,
    }),
    jsonClient('vscode', 'VS Code', join(cwd, '.vscode', 'mcp.json'), 'servers', {
      type: 'stdio',
      command,
      args,
      // VS Code fills this in; it's not a JavaScript template.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code variable.
      cwd: '${workspaceFolder}',
    }),
    // Antigravity's workspace config; its global one is ~/.gemini/config/mcp_config.json.
    jsonClient(
      'antigravity',
      'Antigravity',
      join(cwd, '.agents', 'mcp_config.json'),
      'mcpServers',
      {
        command,
        args,
      },
    ),
    jsonClient(
      'windsurf',
      'Windsurf',
      join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      'mcpServers',
      { command, args },
    ),
    codexClient(join(home, '.codex', 'config.toml')),
  ];
}

/** Clients that look set up here: their project folder exists, or they're installed. */
export function detectClients(cwd: string, home = homedir()): Client[] {
  const found: Record<ClientId, boolean> = {
    claude:
      existsSync(join(cwd, '.mcp.json')) ||
      existsSync(join(cwd, '.claude')) ||
      existsSync(join(cwd, 'CLAUDE.md')) ||
      existsSync(join(home, '.claude')) ||
      onPath('claude'),
    cursor: existsSync(join(cwd, '.cursor')) || existsSync(join(home, '.cursor')),
    vscode: existsSync(join(cwd, '.vscode')) || onPath('code'),
    antigravity:
      existsSync(join(cwd, '.agents', 'mcp_config.json')) ||
      existsSync(join(home, '.gemini', 'config', 'mcp_config.json')) ||
      existsSync(join(home, '.gemini', 'antigravity')) ||
      onPath('antigravity'),
    windsurf: existsSync(join(home, '.codeium', 'windsurf')),
    codex: existsSync(join(home, '.codex')),
  };
  return allClients(cwd, home).filter((c) => found[c.id]);
}

export interface InstallOptions {
  /** Only these clients (and set them up even if they weren't detected). */
  clients?: ClientId[];
  /** Don't ask. */
  yes?: boolean;
  home?: string;
}

function show(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel.startsWith('..') ? path.replace(homedir(), '~') : rel;
}

/** Set up isn't always on: agents run it only with the project open, and some add it switched off. */
const NOT_SHOWING_UP =
  'Not showing up? Your agent runs breakhound only while this folder is open in it, and with breakhound switched on in its MCP settings (Cursor and VS Code may add it switched off), so check both. How, for each agent: https://seybel.github.io/breakhound/guide/agents#not-connected';

export async function installMcp(cwd: string, options: InstallOptions = {}): Promise<number> {
  const home = options.home ?? homedir();
  const clients = options.clients?.length
    ? allClients(cwd, home).filter((c) => options.clients?.includes(c.id))
    : detectClients(cwd, home);
  if (!clients.length) {
    console.log(
      "No coding agent found here. Pick one with --client claude, cursor, vscode, antigravity, windsurf or codex, or add this to your agent's MCP settings:",
    );
    console.log(JSON.stringify({ [SERVER_NAME]: serverCommand() }, null, 2));
    return 1;
  }

  const changes: { client: Client; next: string }[] = [];
  let alreadySetUp = false;
  for (const client of clients) {
    const current = existsSync(client.file) ? readFileSync(client.file, 'utf8') : null;
    try {
      const next = client.update(current);
      if (next === null) {
        alreadySetUp = true;
        console.log(
          `${styleText('green', '✔')} ${client.name}: already set up in ${show(client.file, cwd)}`,
        );
      } else changes.push({ client, next });
    } catch (error) {
      console.log(`${styleText('yellow', '!')} ${client.name}: ${(error as Error).message}`);
    }
  }
  if (!changes.length) {
    // Only for an agent it's in: one whose settings couldn't be changed has nothing to switch on.
    if (alreadySetUp) console.log(`\n${NOT_SHOWING_UP}`);
    return 0;
  }

  console.log('\nbreakhound will add its MCP server to:\n');
  const { command, args } = serverCommand();
  for (const { client } of changes) {
    console.log(`  ${client.name.padEnd(12)} ${show(client.file, cwd)}`);
  }
  console.log(styleText('dim', `\n  The server runs: ${command} ${args.join(' ')}\n`));

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      console.log('Run again with --yes to make these changes.');
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Add it? [Y/n] ')).trim().toLowerCase();
    rl.close();
    if (answer && answer !== 'y' && answer !== 'yes') {
      console.log('Nothing changed.');
      return 0;
    }
  }
  for (const { client, next } of changes) {
    mkdirSync(dirname(client.file), { recursive: true });
    writeFileSync(client.file, next);
    console.log(`${styleText('green', '✔')} ${client.name}: added to ${show(client.file, cwd)}`);
  }
  console.log(
    `\nRestart your agent (or reload its MCP servers), then ask it to "fix the responsive issues breakhound finds".`,
  );
  console.log(NOT_SHOWING_UP);
  return 0;
}
