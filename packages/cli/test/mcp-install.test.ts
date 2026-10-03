import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allClients, installMcp, serverCommand } from '../src/mcp-install';

const temp = (name: string) => mkdtempSync(join(tmpdir(), `breakhound-${name}-`));

describe('mcp install', () => {
  it('adds the server next to existing ones, and does nothing the second time', async () => {
    const project = temp('proj');
    const home = temp('home');
    mkdirSync(join(project, '.cursor'));
    writeFileSync(
      join(project, '.cursor/mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
    );
    expect(
      await installMcp(project, { clients: ['cursor', 'vscode', 'codex'], yes: true, home }),
    ).toBe(0);
    const cursor = JSON.parse(readFileSync(join(project, '.cursor/mcp.json'), 'utf8'));
    expect(Object.keys(cursor.mcpServers)).toEqual(['other', 'breakhound']);
    expect(cursor.mcpServers.breakhound).toEqual(serverCommand());
    const vscode = JSON.parse(readFileSync(join(project, '.vscode/mcp.json'), 'utf8'));
    expect(vscode.servers.breakhound.type).toBe('stdio');
    const toml = readFileSync(join(home, '.codex/config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.breakhound]');

    await installMcp(project, { clients: ['cursor', 'codex'], yes: true, home });
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe(toml);
  });

  it('leaves a config with comments alone and says what to add', () => {
    const project = temp('proj');
    const vscode = allClients(project).find((c) => c.id === 'vscode');
    expect(() => vscode?.update('{ // mine\n "servers": {} }')).toThrow(/isn't plain JSON/);
  });

  it('starts npx through cmd on Windows', () => {
    expect(serverCommand('win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', 'breakhound', 'mcp'],
    });
  });
});
