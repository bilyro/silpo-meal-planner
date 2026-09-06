// Saves the connected client's tools/list result to docs/tools.json (spec §8, Phase 1).
// This is the only authoritative source for Silpo MCP tool argument shapes — read it before
// writing any code in src/mcp/ or src/agent/ that calls a specific tool.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export async function dumpTools(client: Client, tokenMeta?: Record<string, unknown>) {
  const { tools } = await client.listTools();
  const outPath = path.resolve(import.meta.dirname, '../docs/tools.json');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        toolCount: tools.length,
        tokenMeta: tokenMeta ?? null,
        tools,
      },
      null,
      2,
    ),
  );
  return tools;
}
