import { McpAgent } from 'agents/mcp';
import { env } from 'cloudflare:workers';

import type { BrowserEndpoint, BrowserContext } from '@cloudflare/playwright';
import type { KVNamespace } from '@cloudflare/workers-types';

import { endpointURLString, chromium } from '@cloudflare/playwright';
import { createConnection } from '../../src/connection.js';
import { resolveConfig } from '../../src/config.js';
import { ToolCapability } from '../../config.js';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

type Options = {
  vision?: boolean;
  capabilities?: ToolCapability[];
  sessionStorage?: KVNamespace;
  sessionKey?: string;
};

const STORAGE_STATE_KEY = 'storage_state';

// BrowserContextFactory interface (inline to avoid importing from browserContextFactory.ts)
interface BrowserContextFactory {
  createContext(): Promise<{ browserContext: BrowserContext, close: () => Promise<void>, saveSession?: () => Promise<void> }>;
}

// Cloudflare用のBrowserContextFactory実装
class CloudflareBrowserContextFactory implements BrowserContextFactory {
  private readonly cdpEndpoint: string;
  private readonly sessionStorage?: KVNamespace;
  private readonly sessionKey: string;

  constructor(cdpEndpoint: string, sessionStorage?: KVNamespace, sessionKey: string = STORAGE_STATE_KEY) {
    this.cdpEndpoint = cdpEndpoint;
    this.sessionStorage = sessionStorage;
    this.sessionKey = sessionKey;
  }

  async createContext(): Promise<{ browserContext: BrowserContext, close: () => Promise<void>, saveSession?: () => Promise<void> }> {
    const startTime = Date.now();
    console.error(`[createContext] START time=${new Date().toISOString()}`);

    console.error(`[createContext] before connectOverCDP +${Date.now() - startTime}ms`);

    // 30秒タイムアウト付きでCDP接続
    const CDP_TIMEOUT = 30000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`connectOverCDP timeout after ${CDP_TIMEOUT}ms`)), CDP_TIMEOUT);
    });

    const browser = await Promise.race([
      chromium.connectOverCDP(this.cdpEndpoint),
      timeoutPromise
    ]);
    console.error(`[createContext] connectOverCDP done +${Date.now() - startTime}ms`);

    // KVからStorage Stateを読み込み
    let storageState: any = undefined;
    if (this.sessionStorage) {
      try {
        console.error(`[createContext] before KV get +${Date.now() - startTime}ms`);
        const stored = await this.sessionStorage.get(this.sessionKey, 'json');
        console.error(`[createContext] KV get done +${Date.now() - startTime}ms`);
        if (stored) {
          storageState = stored;
          console.error('Loaded storage state from KV');
        }
      } catch (e) {
        console.error('Failed to load storage state:', e);
      }
    }

    // コンテキストを作成（Storage Stateがあれば適用）
    console.error(`[createContext] before newContext +${Date.now() - startTime}ms`);
    const browserContext = await browser.newContext(
      storageState ? { storageState } : undefined
    );
    console.error(`[createContext] newContext done +${Date.now() - startTime}ms`);

    const sessionStorage = this.sessionStorage;
    const sessionKey = this.sessionKey;

    // Storage Stateを保存するヘルパー関数
    const saveStorageState = async () => {
      if (!sessionStorage) return;
      try {
        const state = await browserContext.storageState();
        await sessionStorage.put(sessionKey, JSON.stringify(state));
        console.log('Saved storage state to KV');
      } catch (e) {
        console.error('Failed to save storage state:', e);
      }
    };

    // closeメソッド：Storage Stateを保存してからコンテキストを閉じる
    const close = async () => {
      await saveStorageState();
      await browserContext.close().catch(() => {});
    };

    // セッション保存メソッド（MCPツールから呼び出される）
    const saveSession = sessionStorage ? saveStorageState : undefined;

    return { browserContext, close, saveSession };
  }
}

export function createMcpAgent(endpoint: BrowserEndpoint, options?: Options): typeof McpAgent<typeof env, {}, {}> {
  const cdpEndpoint = typeof endpoint === 'string'
    ? endpoint
    : endpoint instanceof URL
      ? endpoint.toString()
      : endpointURLString(endpoint);

  const sessionStorage = options?.sessionStorage;
  const sessionKey = options?.sessionKey || STORAGE_STATE_KEY;

  const factory = new CloudflareBrowserContextFactory(cdpEndpoint, sessionStorage, sessionKey);

  const connection = (async () => {
    const config = await resolveConfig({
      capabilities: ['core', 'tabs', 'pdf', 'history', 'wait', 'files', 'testing'],
      browser: {
        cdpEndpoint,
      },
      ...options,
    });
    return createConnection(config, factory);
  })();

  return class PlaywrightMcpAgent extends McpAgent<typeof env, {}, {}> {
    server = connection.then(conn => conn.server as unknown as Server);

    async init() {
      // do nothing
    }
  };
}
