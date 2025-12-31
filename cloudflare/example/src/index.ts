import { env } from 'cloudflare:workers';

import { createMcpAgent } from '@cloudflare/playwright-mcp';

export const PlaywrightMCP = createMcpAgent(env.BROWSER, {
  sessionStorage: env.SESSION_STORAGE,
});

function validateAuth(request: Request, env: Env): boolean {
  const token = request.headers.get('Authorization');
  if (!env.PLAYWRIGHT_MCP_AUTH_TOKEN) return true; // トークン未設定なら許可
  return token === `Bearer ${env.PLAYWRIGHT_MCP_AUTH_TOKEN}`;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // 認証チェック
    if (!validateAuth(request, env)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const { pathname }  = new URL(request.url);

    switch (pathname) {
      case '/sse':
      case '/sse/message':
        return PlaywrightMCP.serveSSE('/sse').fetch(request, env, ctx);
      case '/mcp':
        return PlaywrightMCP.serve('/mcp').fetch(request, env, ctx);
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};
