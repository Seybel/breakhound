import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
      await installMcp(project, {
        clients: ['cursor', 'vscode', 'antigravity', 'codex'],
        yes: true,
        home,
      }),
    ).toBe(0);
    const cursor = JSON.parse(readFileSync(join(project, '.cursor/mcp.json'), 'utf8'));
    expect(Object.keys(cursor.mcpServers)).toEqual(['other', 'breakhound']);
    expect(cursor.mcpServers.breakhound).toEqual(serverCommand());
    const vscode = JSON.parse(readFileSync(join(project, '.vscode/mcp.json'), 'utf8'));
    expect(vscode.servers.breakhound.type).toBe('stdio');
    const antigravity = JSON.parse(readFileSync(join(project, '.agents/mcp_config.json'), 'utf8'));
    expect(antigravity.mcpServers.breakhound).toEqual(serverCommand());
    const toml = readFileSync(join(home, '.codex/config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.breakhound]');

    // Already set up, it still says what to check when the agent doesn't show breakhound.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await installMcp(project, { clients: ['cursor', 'codex'], yes: true, home });
      expect(log.mock.calls.flat().join('\n')).toContain('switched on in its MCP settings');
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe(toml);
  });

  it("replaces an entry that would start the unscoped breakhound package, someone else's", () => {
    const project = temp('proj');
    const clients = allClients(project, temp('home'));
    const claude = clients.find((c) => c.id === 'claude');
    const old = JSON.stringify({
      mcpServers: { breakhound: { command: 'npx', args: ['-y', 'breakhound', 'mcp'] } },
    });
    expect(JSON.parse(claude?.update(old) ?? '{}').mcpServers.breakhound).toEqual(serverCommand());
    // One the developer pointed somewhere of their own is theirs.
    const own = JSON.stringify({
      mcpServers: { breakhound: { command: 'node', args: ['bh.js'] } },
    });
    expect(claude?.update(own)).toBeNull();

    const codex = clients.find((c) => c.id === 'codex');
    const toml =
      '[mcp_servers.breakhound]\ncommand = "npx"\nargs = ["-y", "breakhound", "mcp"]\n\n[mcp_servers.other]\ncommand = "other"\n';
    const next = codex?.update(toml) ?? '';
    expect(next).toContain('"@seybel/breakhound"');
    expect(next).not.toContain('"breakhound"');
    expect(next).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(codex?.update(next)).toBeNull();
  });

  it('leaves a config with comments alone and says what to add', async () => {
    const project = temp('proj');
    const vscode = allClients(project).find((c) => c.id === 'vscode');
    expect(() => vscode?.update('{ // mine\n "servers": {} }')).toThrow(/isn't plain JSON/);

    // Nothing was added, so there's nothing to switch on in the agent.
    mkdirSync(join(project, '.vscode'));
    writeFileSync(join(project, '.vscode/mcp.json'), '{ // mine\n "servers": {} }');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await installMcp(project, { clients: ['vscode'], yes: true, home: temp('home') });
      const said = log.mock.calls.flat().join('\n');
      expect(said).toContain("isn't plain JSON");
      expect(said).not.toContain('Not showing up?');
    } finally {
      log.mockRestore();
    }
  });

  it('starts npx through cmd on Windows', () => {
    expect(serverCommand('win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@seybel/breakhound', 'mcp'],
    });
  });
});
