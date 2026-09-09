/**
 * Off-mission or redundant read tools are withheld from the model for cost, not safety (that's
 * test/writeGate.test.ts) — see MODEL_BLOCKED_OFF_MISSION's own comment in SilpoMcpClient.ts for
 * the measured 39% saving on the tool-schema block, which resends on every step of every turn.
 *
 * `get_promotions` and `get_product_details` get their own tests: they're the two cases that were
 * previously handled by prompt discouragement alone (SYSTEM_PROMPT tells the model not to use
 * either) — this pins that the cut is now structural, matching how the cart-hallucination and
 * propose_menu fixes earlier this session both moved off prompt-only reliability once a prompt-
 * only attempt measurably fell short on retest.
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

import { SilpoMcpClient, modelBlockedOffMissionTools, modelBlockedWriteTools } from '../src/mcp/SilpoMcpClient.js';

/** A representative slice of the live server's real tools — see docs/tools.json for the full 40. */
const CORE_TOOLS = [
  'silpo_find_products_batch',
  'silpo_get_my_profile',
  'silpo_get_replacements',
  'silpo_get_shopping_cart_by_id',
  'silpo_list_branches',
  'silpo_get_loyalty_info',
];

async function setup(names: string[]) {
  const mcp = new SilpoMcpClient(42);
  (mcp as unknown as { client: unknown }).client = {
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] })),
    listTools: async () => ({
      tools: names.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
    }),
  };
  return { tools: await mcp.toolsForAiSdk() };
}

describe('off-mission tools withheld from the model', () => {
  it('names exactly the 18 tools measured as never used and off-mission', () => {
    // If Silpo adds a new catalogue/account tool, it must be triaged consciously — hence an exact
    // assertion rather than a length check.
    expect([...modelBlockedOffMissionTools].sort()).toEqual([
      'silpo_find_nova_poshta_offices',
      'silpo_find_nova_poshta_settlements',
      'silpo_get_categories',
      'silpo_get_categories_tree',
      'silpo_get_category',
      'silpo_get_coupon_details',
      'silpo_get_my_certificates',
      'silpo_get_my_favorites',
      'silpo_get_my_offline_orders',
      'silpo_get_my_online_orders',
      'silpo_get_my_premium_subscription',
      'silpo_get_my_promos',
      'silpo_get_popular_categories',
      'silpo_get_product_details',
      'silpo_get_product_sets',
      'silpo_get_products',
      'silpo_get_promotions',
      'silpo_get_similar_products',
    ]);
  });

  it('hands the model none of them', async () => {
    const { tools } = await setup([...CORE_TOOLS, ...modelBlockedOffMissionTools]);

    for (const blocked of modelBlockedOffMissionTools) {
      expect(tools).not.toHaveProperty(blocked);
    }
  });

  it('still hands the model every core tool', async () => {
    const { tools } = await setup([...CORE_TOOLS, ...modelBlockedOffMissionTools]);

    expect(Object.keys(tools).sort()).toEqual([...CORE_TOOLS].sort());
  });

  it('blocks get_promotions and get_product_details structurally, not just by prompt wording', async () => {
    // Both were previously reachable and only discouraged in SYSTEM_PROMPT — see the module
    // comment on MODEL_BLOCKED_OFF_MISSION for why a prompt-only guard wasn't trusted here either.
    const { tools } = await setup([...CORE_TOOLS, 'silpo_get_promotions', 'silpo_get_product_details']);

    expect(tools).not.toHaveProperty('silpo_get_promotions');
    expect(tools).not.toHaveProperty('silpo_get_product_details');
  });

  it('composes with the write-safety block — a tool never gets exposed for either reason', async () => {
    const { tools } = await setup([...CORE_TOOLS, ...modelBlockedWriteTools, ...modelBlockedOffMissionTools]);

    expect(Object.keys(tools).sort()).toEqual([...CORE_TOOLS].sort());
  });

  it('keeps the cache breakpoint on the last surviving tool after both filters', async () => {
    const { tools } = await setup([...CORE_TOOLS, ...modelBlockedWriteTools, ...modelBlockedOffMissionTools]);
    const names = Object.keys(tools);
    const last = names[names.length - 1];

    const marked = names.filter(
      (n) => (tools[n] as { providerOptions?: unknown }).providerOptions !== undefined,
    );
    expect(marked).toEqual([last]);
    expect(modelBlockedOffMissionTools).not.toContain(last);
  });
});
