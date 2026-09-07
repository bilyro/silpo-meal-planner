/**
 * The model must not be handed any tool that mutates a real Silpo account.
 *
 * Regression for a live incident (7 Sept 2026): a user answered «Так» as free text instead of
 * tapping ✅, so the turn went to the agent loop rather than the deterministic handler, and the
 * model called `silpo_add_or_update_cart_products` itself — `quantity: 10` for «Картопля — 1 кг»,
 * against a branch that was not the session's. Ten kilos of potatoes reached a real cart.
 *
 * The guarantee under test is two-sided: the model cannot reach these tools, and our own
 * deterministic code still can.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    TELEGRAM_BOT_TOKEN: 'test',
    ANTHROPIC_API_KEY: 'test',
    PUBLIC_BASE_URL: 'https://example.invalid',
    SILPO_MCP_URL: 'https://example.invalid/mcp',
    DATABASE_URL: 'postgres://test',
    LOG_LEVEL: 'silent',
    MAX_TOOL_CALLS_PER_TURN: 25,
    TURN_TIMEOUT_MS: 60_000,
    PORT: 3000,
    AGENT_MODEL: 'test-model',
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

vi.mock('../src/db/repo.js', () => ({ logToolCall: vi.fn(async () => {}) }));

import { SilpoMcpClient, modelBlockedWriteTools } from '../src/mcp/SilpoMcpClient.js';

/** The live server's 40 tools, by name, as captured in docs/tools.json. */
const READ_TOOLS = [
  'silpo_find_address',
  'silpo_find_products_batch',
  'silpo_get_my_profile',
  'silpo_get_replacements',
  'silpo_get_shopping_cart_by_id',
  'silpo_list_branches',
];

async function setup(names: string[]) {
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }));
  const mcp = new SilpoMcpClient(42);
  (mcp as unknown as { client: unknown }).client = {
    callTool,
    listTools: async () => ({
      tools: names.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
    }),
  };
  return { mcp, callTool, tools: await mcp.toolsForAiSdk() };
}

describe('write tools withheld from the model', () => {
  it('names every account-mutating tool in the blocklist', () => {
    // If Silpo adds a write tool, it must be added here consciously — hence an exact assertion.
    expect([...modelBlockedWriteTools].sort()).toEqual([
      'silpo_add_or_update_cart_products',
      'silpo_add_or_update_certificates',
      'silpo_add_or_update_favorite_products',
      'silpo_clear_shopping_cart',
      'silpo_create_shopping_cart',
      'silpo_remove_cart_products',
      'silpo_update_shopping_cart',
    ]);
  });

  it('hands the model none of them', async () => {
    const { tools } = await setup([...READ_TOOLS, ...modelBlockedWriteTools]);

    for (const blocked of modelBlockedWriteTools) {
      expect(tools).not.toHaveProperty(blocked);
    }
  });

  it('hands the model every read tool', async () => {
    const { tools } = await setup([...READ_TOOLS, ...modelBlockedWriteTools]);

    expect(Object.keys(tools).sort()).toEqual([...READ_TOOLS].sort());
  });

  it('still lets our own deterministic code write — that is where the guards live', async () => {
    const { mcp, callTool } = await setup([...READ_TOOLS, ...modelBlockedWriteTools]);

    // cartContext and the 🛒 handler go through callTool(), not the model's tool map.
    await mcp.callTool('silpo_add_or_update_cart_products', { products: [] });
    await mcp.callTool('silpo_create_shopping_cart', {});
    await mcp.callTool('silpo_clear_shopping_cart', {});

    expect(callTool).toHaveBeenCalledTimes(3);
  });

  it('keeps the cache breakpoint on the last tool after filtering', async () => {
    // The breakpoint has to land on whatever is now last, or the tool block stops being cached and
    // every step of every turn pays full price for ~18k tokens.
    const { tools } = await setup([...READ_TOOLS, ...modelBlockedWriteTools]);
    const names = Object.keys(tools);
    const last = names[names.length - 1];

    const marked = names.filter(
      (n) => (tools[n] as { providerOptions?: unknown }).providerOptions !== undefined,
    );
    expect(marked).toEqual([last]);
    // ...and it must be a tool that survived the filter.
    expect(modelBlockedWriteTools).not.toContain(last);
  });

  it('is stable when the server returns tools in a different order', async () => {
    // Anthropic's cache matches an exact prefix, so a reordered tools/list would silently miss.
    const a = await setup([...READ_TOOLS, ...modelBlockedWriteTools]);
    const b = await setup([...modelBlockedWriteTools, ...READ_TOOLS].reverse());

    expect(Object.keys(a.tools)).toEqual(Object.keys(b.tools));
  });
});
