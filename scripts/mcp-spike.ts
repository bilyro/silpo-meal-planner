// Phase 1 spike (spec §8, Phase 1): prove we can log in to the Silpo MCP and call a tool.
// Run with: npm run spike
//
// This owns PUBLIC_BASE_URL's port itself for the OAuth redirect — stop `npm run dev` first.
// It opens a real login flow against auth.silpo.ua (phone + OTP or password) in your browser;
// there is no sandbox, so this authenticates as your real Silpo account (spec §4.6).

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { config } from '../src/config.js';
import { InMemorySilpoAuthProvider } from '../src/mcp/InMemorySilpoAuthProvider.js';
import { dumpTools } from './dump-tools.js';

function waitForCallback(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        error
          ? `<h1>Помилка авторизації: ${error}</h1>`
          : '<h1>Готово, повертайтесь у термінал.</h1>',
      );
      server.close();
      if (error) reject(new Error(`Authorization failed: ${error}`));
      else if (code) resolve(code);
      else reject(new Error('No code or error in callback query string'));
    });
    server.listen(port);
  });
}

function openInBrowser(url: URL) {
  console.log('\nВідкрийте це посилання в браузері та увійдіть у свій акаунт Сільпо:\n');
  console.log(url.toString());
  console.log('');
  if (process.platform === 'darwin') execFile('open', [url.toString()]);
}

async function main() {
  const redirectUri = new URL('/auth/callback', config.PUBLIC_BASE_URL);
  const callbackPort = Number(redirectUri.port || 80);

  const auth = new InMemorySilpoAuthProvider(redirectUri.toString(), openInBrowser);
  const makeClient = () => new Client({ name: 'silpo-meal-planner-spike', version: '0.1.0' }, { capabilities: {} });
  const makeTransport = () =>
    new StreamableHTTPClientTransport(new URL(config.SILPO_MCP_URL), { authProvider: auth });

  let client = makeClient();

  try {
    await client.connect(makeTransport());
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
    console.log('Очікую авторизацію...');
    const code = await waitForCallback(callbackPort);
    // A transport that has thrown UnauthorizedError from connect() can't be reused for a
    // retry ("already started"); finish the code exchange on a fresh transport instance,
    // sharing the same authProvider so it picks up the tokens just saved by finishAuth.
    await makeTransport().finishAuth(code);
    client = makeClient();
    await client.connect(makeTransport());
  }

  console.log('\n✅ Автентифіковано. Отримую tools/list...');
  const tokenMeta = auth.describeTokens();
  console.log('Token metadata (redacted):', tokenMeta);
  const tools = await dumpTools(client, tokenMeta);
  console.log(`Збережено ${tools.length} інструментів у docs/tools.json`);

  console.log('\n--- silpo_get_my_profile ---');
  const profile = await client.callTool({ name: 'silpo_get_my_profile', arguments: {} });
  console.log(JSON.stringify(profile, null, 2));

  console.log('\n--- silpo_get_my_shopping_cart ---');
  const cart = await client.callTool({ name: 'silpo_get_my_shopping_cart', arguments: {} });
  console.log(JSON.stringify(cart, null, 2));

  await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Spike failed:', err);
  process.exit(1);
});
