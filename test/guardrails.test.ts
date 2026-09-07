/**
 * Spec §8 Phase 6 item 4 — the two runtime guardrails: a hard per-turn deadline in runAgentTurn,
 * and consecutive-duplicate suppression in SilpoMcpClient. Nothing here touches the network: the
 * Silpo account is real and unsandboxed, so the MCP `Client` is a fake and the LLM call is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts calls process.exit(1) when required env vars are missing, which would kill the test
// run before a single assertion; the logger otherwise spawns a pino-pretty worker thread.
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

vi.mock('../src/db/repo.js', () => ({
  logToolCall: vi.fn(async () => {}),
  getRecentMessages: vi.fn(async () => []),
  appendMessages: vi.fn(async () => {}),
  getSessionState: vi.fn(async () => undefined),
  saveSessionState: vi.fn(async () => {}),
  // Durable memory (agent/memory.ts) is read on every turn; an empty user remembers nothing.
  listUserFacts: vi.fn(async () => []),
  listRecentPlans: vi.fn(async () => []),
}));

vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn(() => ({ modelId: 'test-model' })) }));

// Only generateText is replaced — `tool`/`jsonSchema` are the real ones, so the tool wrappers
// under test are built exactly as they are in production.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}));

import { generateText } from 'ai';
import * as repo from '../src/db/repo.js';
import { runAgentTurn } from '../src/agent/runAgentTurn.js';
import { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';

const generateTextMock = vi.mocked(generateText);
const logToolCallMock = vi.mocked(repo.logToolCall);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('per-turn deadline', () => {
  function stubMcp() {
    vi.spyOn(SilpoMcpClient.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(SilpoMcpClient.prototype, 'toolsForAiSdk').mockResolvedValue({});
    return vi.spyOn(SilpoMcpClient.prototype, 'close').mockResolvedValue(undefined);
  }

  it('answers with a friendly Ukrainian message instead of hanging, and still closes the client', async () => {
    const close = stubMcp();
    // A tool call that never resolves: the AI SDK hands its abort signal to `execute` but cannot
    // interrupt one that ignores it, which is precisely the case the deadline exists for.
    generateTextMock.mockImplementation(() => new Promise(() => {}) as never);
    vi.useFakeTimers();

    const turn = runAgentTurn(42, 'меню на 3 дні');
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await turn;

    expect(result.text).toContain('надто багато часу');
    expect(result.text).not.toContain('Error');
    expect(result.stage).toBe('idle');
    expect(close).toHaveBeenCalledTimes(1);
    // A timed-out turn must not persist a fake assistant reply into the conversation history.
    expect(repo.appendMessages).not.toHaveBeenCalled();
  });

  it('aborts the signal it handed to generateText so the in-flight request is cancelled', async () => {
    stubMcp();
    generateTextMock.mockImplementation(() => new Promise(() => {}) as never);
    vi.useFakeTimers();

    const turn = runAgentTurn(42, 'меню на 3 дні');
    await vi.advanceTimersByTimeAsync(60_000);
    await turn;

    const signal = generateTextMock.mock.calls[0]?.[0].abortSignal;
    expect(signal?.aborted).toBe(true);
  });

  it('leaves a turn that finishes in time untouched, with a live (unaborted) signal', async () => {
    stubMcp();
    generateTextMock.mockResolvedValue({ text: 'Ось меню', steps: [{ toolCalls: [] }] } as never);
    vi.useFakeTimers();

    const result = await runAgentTurn(42, 'меню на 3 дні');

    expect(result.text).toBe('Ось меню');
    expect(generateTextMock.mock.calls[0]?.[0].abortSignal?.aborted).toBe(false);
    expect(repo.appendMessages).toHaveBeenCalledTimes(1);
    // The deadline timer must be cleared on the happy path, or every turn would leave one behind.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('consecutive duplicate tool calls', () => {
  const TOOL_NAMES = [
    'silpo_get_shopping_cart_by_id',
    'silpo_add_or_update_cart_products',
    'silpo_find_products_batch',
  ];

  function makeClient() {
    // Mirrors the MCP SDK's (params, resultSchema, options) shape so the forwarded options are
    // observable in the third argument.
    const callTool = vi.fn(async (_params: unknown, _resultSchema?: unknown, _options?: unknown) => ({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
    }));
    const listTools = vi.fn(async () => ({
      tools: TOOL_NAMES.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
    }));
    return { callTool, listTools };
  }

  /** Builds a connected-looking client over a fake MCP `Client`, plus a model-call helper. */
  async function setup() {
    const fake = makeClient();
    const mcp = new SilpoMcpClient(42);
    (mcp as unknown as { client: unknown }).client = fake;
    const tools = await mcp.toolsForAiSdk();

    const asModel = async (name: string, args: Record<string, unknown> = {}, options: unknown = {}) => {
      const execute = tools[name]?.execute as unknown as (a: unknown, o: unknown) => Promise<unknown>;
      return execute(args, options);
    };
    return { mcp, fake, asModel };
  }

  function dedupeLogs() {
    return logToolCallMock.mock.calls.filter((c) => c[0].error?.startsWith('duplicate_tool_call'));
  }

  it('stops sending model calls once MAX_TOOL_CALLS_PER_TURN is reached', async () => {
    const { fake, asModel } = await setup();

    // Varying args so the dedupe guard never fires — this must be the budget, nothing else.
    for (let i = 0; i < 25; i++) {
      await asModel('silpo_find_products_batch', { products: [`товар-${i}`] });
    }
    expect(fake.callTool).toHaveBeenCalledTimes(25);

    const overBudget = await asModel('silpo_find_products_batch', { products: ['ще один'] });
    expect(fake.callTool).toHaveBeenCalledTimes(25);
    expect(overBudget).toMatchObject({ error: 'tool_call_budget_exhausted' });
  });

  it('does not charge the budget for deterministic calls from our own code', async () => {
    const { mcp, fake, asModel } = await setup();

    // resolveIngredients legitimately makes many calls; they run outside an agent turn and must
    // not be able to exhaust the model's budget.
    for (let i = 0; i < 30; i++) {
      await mcp.callTool('silpo_find_products_batch', { products: [`інгредієнт-${i}`] });
    }
    const afterwards = await asModel('silpo_get_shopping_cart_by_id', { shoppingCartId: 'c1' });

    expect(afterwards).not.toMatchObject({ error: 'tool_call_budget_exhausted' });
    expect(fake.callTool).toHaveBeenCalledTimes(31);
  });

  it('suppresses the second identical call and tells the model to change course', async () => {
    const { fake, asModel } = await setup();

    await asModel('silpo_find_products_batch', { products: ['молоко'] });
    const second = await asModel('silpo_find_products_batch', { products: ['молоко'] });

    expect(fake.callTool).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ error: 'duplicate_tool_call' });
    // An error, not a replay of the previous result: a replayed result reads as a fresh answer and
    // the model would keep asking until the step budget is gone.
    expect(second).not.toHaveProperty('success');
  });

  it('records the suppressed call in tool_call_log rather than letting it vanish', async () => {
    const { asModel } = await setup();

    await asModel('silpo_find_products_batch', { products: ['молоко'] });
    await asModel('silpo_find_products_batch', { products: ['молоко'] });

    expect(dedupeLogs()).toHaveLength(1);
    expect(dedupeLogs()[0]?.[0]).toMatchObject({
      userId: 42,
      tool: 'silpo_find_products_batch',
      args: { products: ['молоко'] },
      ok: false,
      ms: 0,
    });
  });

  it('treats reordered argument keys as the same call', async () => {
    const { fake, asModel } = await setup();

    await asModel('silpo_find_products_batch', { products: ['молоко'], limit: 5 });
    await asModel('silpo_find_products_batch', { limit: 5, products: ['молоко'] });

    expect(fake.callTool).toHaveBeenCalledTimes(1);
  });

  it('still allows a re-read after a call that changed the data (read → write → read)', async () => {
    const { mcp, fake, asModel } = await setup();

    // The write is deliberately NOT a model call: cart-mutating tools are withheld from the model
    // (see test/writeGate.test.ts), so the real sequence is the model reading the cart, the 🛒
    // handler writing it through callTool(), and the model reading it back.
    await asModel('silpo_get_shopping_cart_by_id', { shoppingCartId: 'c1' });
    await mcp.callTool('silpo_add_or_update_cart_products', { shoppingCartId: 'c1', products: [{ id: 'p1' }] });
    await asModel('silpo_get_shopping_cart_by_id', { shoppingCartId: 'c1' });

    // The whole point of "consecutive" rather than "any repeat this turn": the cart genuinely
    // differs across those two reads, so blocking the second would break the cart flow.
    expect(fake.callTool).toHaveBeenCalledTimes(3);
    expect(dedupeLogs()).toHaveLength(0);
  });

  it('stays blocked while the model keeps repeating itself, then unblocks on a different call', async () => {
    const { fake, asModel } = await setup();

    await asModel('silpo_find_products_batch', { products: ['молоко'] });
    await asModel('silpo_find_products_batch', { products: ['молоко'] });
    await asModel('silpo_find_products_batch', { products: ['молоко'] });
    await asModel('silpo_find_products_batch', { products: ['хліб'] });

    expect(fake.callTool).toHaveBeenCalledTimes(2);
    expect(dedupeLogs()).toHaveLength(2);
  });

  it('does not gate our own deterministic code, which repeats calls on purpose', async () => {
    const { mcp, fake } = await setup();

    await mcp.callTool('silpo_get_shopping_cart_by_id', { shoppingCartId: 'c1' });
    await mcp.callTool('silpo_get_shopping_cart_by_id', { shoppingCartId: 'c1' });

    expect(fake.callTool).toHaveBeenCalledTimes(2);
  });

  it('forwards the turn abort signal to the MCP request', async () => {
    const { fake, asModel } = await setup();
    const controller = new AbortController();

    await asModel('silpo_find_products_batch', { products: ['молоко'] }, { abortSignal: controller.signal });

    expect(fake.callTool.mock.calls[0]?.[2]).toEqual({ signal: controller.signal });
  });
});
