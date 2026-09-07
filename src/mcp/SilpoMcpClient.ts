import { tool, jsonSchema, type Tool, type JSONSchema7 } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { config } from '../config.js';
import * as repo from '../db/repo.js';
import { SilpoAuthProvider } from './SilpoAuthProvider.js';

export class NeedsAuthError extends Error {
  /**
   * Undefined when the SDK reported a 401 without getting far enough to mint an authorize URL —
   * e.g. its own "Server returned 401 after successful authentication" guard. Callers then fall
   * back to asking the user for /start instead of offering a button.
   */
  constructor(public readonly authorizationUrl?: URL) {
    super('Silpo account not linked, or the link expired; user must (re-)authorize');
  }
}

function redirectUri(): string {
  return new URL('/auth/callback', config.PUBLIC_BASE_URL).toString();
}

function makeTransport(auth: SilpoAuthProvider): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(config.SILPO_MCP_URL), { authProvider: auth });
}

/** Completes the Authorization Code + PKCE exchange started by SilpoMcpClient.connect(). */
export async function completeAuthorization(userId: number, code: string, codeVerifier: string): Promise<void> {
  const auth = new SilpoAuthProvider(userId, redirectUri(), undefined, codeVerifier);
  await makeTransport(auth).finishAuth(code);
}

// Spec §4.5: exponential backoff with jitter, base 500ms, max 5 retries, only on 429 / transient
// network errors. StreamableHTTPError.code carries the HTTP status for non-2xx responses
// (verified against @modelcontextprotocol/sdk@1.30.0's streamableHttp.js); ECONNRESET-style
// failures surface as a fetch TypeError with a `cause.code` from Node's undici.
const RETRY_BASE_MS = 500;
const RETRY_MAX_ATTEMPTS = 5;

function isRetryable(err: unknown): boolean {
  if (err instanceof StreamableHTTPError && err.code === 429) return true;
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  if (cause?.code === 'ECONNRESET' || cause?.code === 'ETIMEDOUT') return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stable fingerprint of a tool call. Key order is normalised because the model re-emits its
 * arguments as free-form JSON, so the *same* call can arrive with the keys shuffled.
 */
function fingerprint(name: string, args: Record<string, unknown>): string {
  const stable = JSON.stringify(args, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value,
  );
  return `${name}:${stable}`;
}

/** Written to `tool_call_log.error` so a suppressed call is auditable rather than invisible. */
const DUPLICATE_CALL_LOG = 'duplicate_tool_call: identical to the immediately preceding call, not sent to Silpo';

const DUPLICATE_CALL_RESULT = {
  error: 'duplicate_tool_call',
  message:
    'Ти щойно викликав цей самий інструмент з тими самими аргументами — результат не змінився, ' +
    'тому запит не відправлено. Не повторюй його: зміни аргументи, візьми інший інструмент або ' +
    'відповідай користувачеві тим, що вже маєш.',
} as const;

const BUDGET_EXHAUSTED_LOG = 'tool_call_budget_exhausted: MAX_TOOL_CALLS_PER_TURN reached, not sent to Silpo';

const BUDGET_EXHAUSTED_RESULT = {
  error: 'tool_call_budget_exhausted',
  message:
    'Ліміт викликів інструментів на цей хід вичерпано. Більше запитів до Сільпо не буде — ' +
    'відповідай користувачеві тим, що вже маєш, і запропонуй продовжити наступним повідомленням.',
} as const;

function parseToolResult<T>(res: Awaited<ReturnType<Client['callTool']>>): T {
  if (res.structuredContent) return res.structuredContent as T;
  const first = Array.isArray(res.content) ? res.content[0] : undefined;
  if (first && first.type === 'text') return JSON.parse(first.text) as T;
  return res.content as T;
}

/**
 * Per-user MCP client. connect() either succeeds (tokens already valid/refreshed) or throws
 * NeedsAuthError carrying the URL to send the user to — the caller decides how to present it
 * (an inline Telegram button today; the agent loop in Phase 3 will surface it as a reply).
 */
export class SilpoMcpClient {
  private client: Client | undefined;

  /**
   * Fingerprint of the last call that actually reached Silpo. runAgentTurn builds one client per
   * turn, so this is turn-scoped without any extra plumbing; see callModelTool() for how it is used.
   */
  private lastCall: string | undefined;

  /**
   * Model-issued calls made this turn (spec §4.5: "cap tool calls at 25 per agent turn").
   *
   * `stopWhen: stepCountIs(...)` in runAgentTurn caps STEPS — LLM round-trips — not tool calls, and
   * Claude emits several parallel `tool_use` blocks in a single step, so 25 steps can be many more
   * than 25 calls against a real, rate-limited account. This counter is the literal cap.
   *
   * Deterministic calls from our own code are deliberately not counted: `resolveIngredients` alone
   * legitimately makes a batch call per 30 ingredients plus a replacement lookup per miss, and it
   * runs on its own client outside any agent turn. The cap exists to stop the model looping.
   */
  private modelCalls = 0;

  /**
   * Authorize URL captured from the auth provider's redirectToAuthorization callback.
   *
   * Instance state rather than a local inside connect(), because the transport keeps the same
   * provider for the life of the client: when an access token expires *mid-turn* the SDK refreshes
   * (streamableHttp.js handles 401 by calling auth() and retrying once), and if that refresh fails
   * it starts a fresh authorization and invokes this callback again. Held in a local, that URL was
   * written to a dead closure and the user got a generic error instead of a way to re-link.
   */
  private pendingAuthUrl: URL | undefined;

  /**
   * Set when a call failed with 401 that could not be refreshed (spec §4: "handle 401 by refreshing
   * once, then falling back to a re-link prompt").
   *
   * Needed *in addition to* throwing, because the two call paths surface errors differently: a
   * throw from our own deterministic code propagates to the bot's error boundary, but a throw
   * inside a model-issued tool call is caught by the AI SDK and turned into a `tool-error` fed back
   * to the model (verified in ai@7's executeToolCall), so it never reaches runAgentTurn's catch.
   * runAgentTurn reads this flag after the loop to override the reply.
   */
  needsAuth: NeedsAuthError | undefined;

  constructor(private readonly userId: number) {}

  /** Records the 401 so runAgentTurn can see it, and returns the error to throw. */
  private authFailure(): NeedsAuthError {
    const err = new NeedsAuthError(this.pendingAuthUrl);
    this.needsAuth = err;
    return err;
  }

  async connect(): Promise<void> {
    const auth = new SilpoAuthProvider(this.userId, redirectUri(), (url) => {
      this.pendingAuthUrl = url;
    });
    const client = new Client({ name: 'silpo-meal-planner', version: '0.1.0' }, { capabilities: {} });
    try {
      await client.connect(makeTransport(auth));
    } catch (err) {
      if (err instanceof UnauthorizedError) throw this.authFailure();
      throw err;
    }
    this.client = client;
  }

  /** Retry/backoff + tool_call_log wrapper shared by callTool() and every generated AI SDK tool. */
  private async callToolWithLogging<T>(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.client) throw new Error('SilpoMcpClient.connect() must succeed before calling tools');
    const client = this.client;
    // Recorded for every call, model-issued or not: our own deterministic code (cartContext,
    // resolveIngredients) is trusted to repeat a call on purpose, but its calls still count as
    // "the previous call" when deciding whether the model's next one is a pointless repeat.
    this.lastCall = fingerprint(name, args);
    const t0 = Date.now();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        // The signal comes from the turn deadline in runAgentTurn, so a timed-out turn actually
        // cancels its in-flight HTTP request instead of leaving it running against the real API.
        const res = await client.callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined);
        if (res.isError) throw new Error(`Tool ${name} failed: ${JSON.stringify(res.content)}`);
        const result = parseToolResult<T>(res);
        await repo.logToolCall({ userId: this.userId, tool: name, args, ok: true, ms: Date.now() - t0 });
        return result;
      } catch (err) {
        lastErr = err;
        if (attempt < RETRY_MAX_ATTEMPTS && isRetryable(err)) {
          const backoff = RETRY_BASE_MS * 2 ** attempt;
          await sleep(backoff + Math.random() * backoff * 0.5);
          continue;
        }
        break;
      }
    }
    await repo.logToolCall({
      userId: this.userId,
      tool: name,
      args,
      ok: false,
      ms: Date.now() - t0,
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    // Logged as itself above, then converted: the transport has already tried a refresh and given
    // up by the time it throws this, so the only thing left to offer the user is a re-link.
    if (lastErr instanceof UnauthorizedError) throw this.authFailure();
    throw lastErr;
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.callToolWithLogging<T>(name, args);
  }

  /**
   * Entry point for calls the *model* improvises, with the consecutive-duplicate guard from spec
   * §8 Phase 6 item 4. A tool-calling model that dislikes a result sometimes reissues the identical
   * call in a loop, burning the step budget and hammering a real (rate-limited, unsandboxed) API.
   *
   * Only *consecutive* duplicates are blocked, deliberately. Repeating a call later in the turn is
   * routine and correct — `silpo_get_shopping_cart_by_id` before and after
   * `silpo_add_or_update_cart_products` genuinely returns different data — and any such re-read is
   * separated by the call that changed the data, so it is never consecutive. A "no repeats at all
   * this turn" rule would break exactly the read-after-write pattern the cart flow is built on.
   *
   * The duplicate gets an error back rather than a replay of the earlier result: a silent replay is
   * indistinguishable from a fresh answer, so a model stuck on a dead end would keep asking and
   * still exhaust the step budget, just without the network traffic. An error is a signal to change
   * course. `lastCall` is intentionally left in place here, so the same call stays blocked until the
   * model actually does something different.
   */
  private async callModelTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.modelCalls >= config.MAX_TOOL_CALLS_PER_TURN) {
      await repo.logToolCall({ userId: this.userId, tool: name, args, ok: false, ms: 0, error: BUDGET_EXHAUSTED_LOG });
      return BUDGET_EXHAUSTED_RESULT;
    }
    if (this.lastCall === fingerprint(name, args)) {
      // Logged like any other call (ms: 0, ok: false) — tool_call_log is a submission deliverable,
      // so a suppressed call has to be visible as suppressed rather than simply missing.
      await repo.logToolCall({ userId: this.userId, tool: name, args, ok: false, ms: 0, error: DUPLICATE_CALL_LOG });
      return DUPLICATE_CALL_RESULT;
    }
    // Counted only for calls that actually reach Silpo: a suppressed duplicate cost nothing, and
    // charging the budget for it would let a looping model exhaust the turn without a single request.
    this.modelCalls += 1;
    return this.callToolWithLogging(name, args, signal);
  }

  /**
   * Exposes every Silpo MCP tool (spec §6.2 — all ~40, not a hand-picked subset) as an AI SDK
   * tool, routed through the same retry/backoff + tool_call_log path as callTool(). Must be
   * called after connect() has succeeded.
   */
  async toolsForAiSdk(): Promise<Record<string, Tool>> {
    if (!this.client) throw new Error('SilpoMcpClient.connect() must succeed before toolsForAiSdk()');
    const { tools } = await this.client.listTools();
    // Sorted by name so the serialised tool block is byte-identical between requests. Anthropic's
    // prompt cache matches on an exact prefix, so if Silpo ever returned tools/list in a different
    // order the cache would silently miss on every turn and we would pay the write price forever.
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    const lastIndex = sorted.length - 1;

    return Object.fromEntries(
      sorted.map((t, index) => [
        t.name,
        tool({
          description: t.description ?? t.name,
          inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
          // A cache breakpoint on the FINAL tool caches the whole tool block, which measured at
          // 18,012 of the 20,158 input tokens on a typical turn — 89%. The tool block sits before
          // `system` in Anthropic's request order, so this stays valid even though the system
          // prompt carries per-turn session state and changes every time.
          //
          // Worth understanding: an agent turn is not one request. `stopWhen: stepCountIs(...)`
          // means up to MAX_TOOL_CALLS_PER_TURN round-trips, each resending this block in full, so
          // the saving multiplies by the number of steps rather than applying once.
          ...(index === lastIndex
            ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' as const } } } }
            : {}),
          execute: (args, { abortSignal }) =>
            this.callModelTool(t.name, args as Record<string, unknown>, abortSignal),
        }),
      ]),
    );
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}
