/**
 * Where `breakhound mcp` listens for the browser extension: the first free port of these, on
 * 127.0.0.1 only. A few in a row, so agents open in several projects can each have one.
 */
export const BRIDGE_PORTS: readonly number[] = Array.from({ length: 10 }, (_, i) => 47821 + i);
