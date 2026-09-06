import { randomBytes } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import * as repo from '../db/repo.js';

/**
 * DB-backed OAuthClientProvider (spec §5.3, §9.1). One instance is created per operation
 * (starting a link, or completing one) rather than kept alive across requests — all state
 * that needs to survive lives in oauth_clients/oauth_tokens/oauth_pending, keyed by userId.
 *
 * No `state()` method: Silpo's authorization server does not reliably echo the OAuth `state`
 * param back on redirect (confirmed empirically — with or without one, the callback arrives
 * with only `code`), so /auth/callback falls back to the most recent oauth_pending row instead
 * of matching by state. Fine for this hackathon's scale; a real multi-tenant deployment would
 * need Silpo to fix state echoing, or a different correlation channel.
 */
export class SilpoAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly userId: number,
    private readonly redirectUri: string,
    private readonly onAuthorizationUrl: (url: URL) => void = () => {},
    /** Pre-loaded verifier for the callback flow, where we already fetched the oauth_pending row. */
    private readonly injectedCodeVerifier?: string,
  ) {}

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'silpo-meal-planner',
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return repo.getOauthClient();
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await repo.saveOauthClient(info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return repo.getTokens(this.userId);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await repo.saveTokens(this.userId, tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onAuthorizationUrl(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    // oauth_pending.state is just our own internal row id here, never sent to Silpo.
    await repo.savePendingAuth(randomBytes(16).toString('hex'), this.userId, codeVerifier);
  }

  codeVerifier(): string {
    if (!this.injectedCodeVerifier) {
      throw new Error('No code verifier available on this provider instance');
    }
    return this.injectedCodeVerifier;
  }
}
