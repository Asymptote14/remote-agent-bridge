import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export type NetworkMode = 'local' | 'sakura' | 'lan';
export type RuntimeConfig = {
  networkMode: NetworkMode;
  host: string;
  port: number;
  publicUrl: string;
  deviceName: string;
  /** Local JSON file containing enabled Provider definitions. */
  providersFile: string;
};
export type ProviderConfig = {
  id: string;
  name: string;
  /** Adapter implementation selected by the local Agent. */
  adapter?: 'workbuddy' | 'codex' | 'generic-cli' | 'http' | string;
  transport: 'http' | 'websocket' | 'mcp' | 'cli' | 'gui';
  /** HTTP/WebSocket/MCP endpoint. CLI providers use executable instead. */
  endpoint?: string;
  /** CLI entry point. For WorkBuddy this is the bundled codebuddy launcher. */
  executable?: string;
  /** Optional Node runtime used to launch a JavaScript CLI. */
  runtime?: string;
  /** Working directory passed to the provider process. */
  cwd?: string;
  /** Provider-specific permission policy. */
  permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions';
  /** Codex CLI sandbox policy. Defaults to read-only. */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  token?: string;
  enabled: boolean;
};

/**
 * The Gateway and the Agent must agree on one data directory: it holds the
 * shared state, the device identity and the setup token that proves the Agent
 * runs on this machine. Resolving from `process.cwd()` made them disagree
 * whenever they were started from different working directories (for example
 * `pnpm dev`, which runs each package in its own folder), producing a silent
 * split-brain set of `.rab` directories. Anchor on the workspace root instead.
 */
function findWorkspaceRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = resolve(current, '..');
    if (parent === current) return resolve(start);
    current = parent;
  }
}

const configuredDataDir = process.env.RAB_DATA_DIR?.trim();
const defaultDataDir = configuredDataDir
  ? (isAbsolute(configuredDataDir) ? configuredDataDir : resolve(process.cwd(), configuredDataDir))
  : join(findWorkspaceRoot(process.cwd()), '.rab');
const configuredRuntimePath = process.env.RAB_CONFIG_FILE?.trim();
export const runtimeConfigPath = configuredRuntimePath
  ? (isAbsolute(configuredRuntimePath) ? configuredRuntimePath : resolve(process.cwd(), configuredRuntimePath))
  : join(defaultDataDir, 'config.json');
export const defaultProviderConfigPath = join(defaultDataDir, 'providers.json');
/** All runtime data (state.json, device identity, providers) lives here. */
export const dataDir = defaultDataDir;
/** Secret proving a setup request came from the local operator. */
export const setupTokenPath = join(defaultDataDir, 'setup-token');
const configuredProviderPath = process.env.RAB_PROVIDERS_FILE?.trim();
const environmentProviderPath = configuredProviderPath
  ? (isAbsolute(configuredProviderPath) ? configuredProviderPath : resolve(process.cwd(), configuredProviderPath))
  : undefined;
export const defaultRuntimeConfig: RuntimeConfig = {
  networkMode: 'sakura',
  host: '127.0.0.1',
  port: 8787,
  publicUrl: '',
  deviceName: 'My Computer',
  providersFile: environmentProviderPath || defaultProviderConfigPath,
};

function normalizeProvidersFile(value: unknown): string {
  const configured = String(value ?? '').trim();
  if (!configured) return defaultRuntimeConfig.providersFile;
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

export function readRuntimeConfig(): RuntimeConfig {
  if (!existsSync(runtimeConfigPath)) return { ...defaultRuntimeConfig };
  try {
    const parsed = JSON.parse(readFileSync(runtimeConfigPath, 'utf8')) as Partial<RuntimeConfig>;
    return {
      ...defaultRuntimeConfig,
      ...parsed,
      port: Number(parsed.port ?? defaultRuntimeConfig.port),
      host: parsed.host || defaultRuntimeConfig.host,
      deviceName: parsed.deviceName || defaultRuntimeConfig.deviceName,
      providersFile: environmentProviderPath || normalizeProvidersFile(parsed.providersFile),
    };
  } catch {
    return { ...defaultRuntimeConfig };
  }
}

export function writeRuntimeConfig(input: Partial<RuntimeConfig>): RuntimeConfig {
  const current = readRuntimeConfig();
  const networkMode = input.networkMode ?? current.networkMode;
  const host = networkMode === 'lan' ? '0.0.0.0' : '127.0.0.1';
  const next: RuntimeConfig = {
    ...current,
    ...input,
    networkMode,
    host,
    port: Math.min(Math.max(Number(input.port ?? current.port), 1024), 65535),
    publicUrl: String(input.publicUrl ?? current.publicUrl).trim(),
    deviceName: String(input.deviceName ?? current.deviceName).trim().slice(0, 80) || 'My Computer',
    providersFile: environmentProviderPath || normalizeProvidersFile(input.providersFile ?? current.providersFile),
  };
  mkdirSync(join(runtimeConfigPath, '..'), { recursive: true });
  writeFileSync(runtimeConfigPath, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(runtimeConfigPath, 0o600); } catch { /* Windows may ignore POSIX file modes. */ }
  return next;
}

export function readProviderConfigs(): ProviderConfig[] {
  const providerPath = readRuntimeConfig().providersFile;
  if (!existsSync(providerPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(providerPath, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.id === 'string') as ProviderConfig[] : [];
  } catch { return []; }
}

export function writeProviderConfigs(items: ProviderConfig[]): ProviderConfig[] {
  const providerPath = readRuntimeConfig().providersFile;
  mkdirSync(resolve(providerPath, '..'), { recursive: true });
  writeFileSync(providerPath, JSON.stringify(items, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(providerPath, 0o600); } catch { /* Windows may ignore POSIX file modes. */ }
  return items;
}

export function getProviderConfigPath(): string {
  return readRuntimeConfig().providersFile;
}

/**
 * Loopback is not proof of locality: the tunnel clients this project supports
 * (sakura / frp-style forwarders, and most reverse proxies) connect to the
 * Gateway from 127.0.0.1, so every remote request arrives looking local. Any
 * endpoint that can re-bind the computer or read stored secrets therefore
 * requires this token, which only a process that can read the data directory
 * on this machine can obtain.
 */
export function readSetupToken(): string {
  try {
    const existing = readFileSync(setupTokenPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* not created yet */ }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(setupTokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(setupTokenPath, 0o600); } catch { /* Windows may ignore POSIX file modes. */ }
  return token;
}

export function validSetupToken(candidate: string): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(readSetupToken(), 'utf8');
  const actual = Buffer.from(candidate, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
