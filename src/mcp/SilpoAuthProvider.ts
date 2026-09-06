import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * In-memory OAuthClientProvider for the Phase 1 spike only (spec §8 Phase 1, §9.1).
 * Phase 2 replaces this with a DB-backed provider (oauth_clients/oauth_tokens/oauth_pending
 * tables) so registration and tokens survive process restarts and are keyed per Telegram user.
 */
export class SilpoAuthProvider implements OAuthClientProvider {
  private clientInfo: OAuthClientInformationFull | undefined;
  private tokenSet: OAuthTokens | undefined;
  private verifier: string | undefined;

  constructor(
    private readonly redirectUri: string,
    private readonly onAuthorizationUrl: (url: URL) => void,
  ) {}

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'silpo-meal-planner (spike)',
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.clientInfo;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.clientInfo = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.tokenSet;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.tokenSet = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onAuthorizationUrl(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('No PKCE code verifier saved yet');
    return this.verifier;
  }
}
