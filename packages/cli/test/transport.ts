import type { PassThrough } from 'node:stream';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** An MCP client transport over a pair of in-memory streams. */
export class StreamTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private buffer = '';
  constructor(
    private readonly toServer: PassThrough,
    private readonly fromServer: PassThrough,
  ) {}
  async start(): Promise<void> {
    this.fromServer.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      for (let i = this.buffer.indexOf('\n'); i !== -1; i = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (line.trim()) this.onmessage?.(JSON.parse(line));
      }
    });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.toServer.write(`${JSON.stringify(message)}\n`);
  }
  async close(): Promise<void> {
    this.toServer.end();
    this.onclose?.();
  }
}
