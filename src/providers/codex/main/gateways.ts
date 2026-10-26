import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, TomlError } from 'smol-toml';

// A gateway is a Codex profile file named <name>.toml in the gateways folder of Codex's home. Codex
// loads profiles only from its home folder itself, so the app reads the selected file and passes its
// settings with the session's thread. The file may hold a token: the app keeps no copy of the settings,
// never logs or shows them, and hides their text in Codex's errors (ADR-0008).

// Letters, digits, dots, hyphens and underscores, starting with a letter or digit, so that a gateway's
// name can never lead outside the folder.
const GATEWAY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Keys that would change what a parsed object is, rather than add a setting to it.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// A JSON value, in which form the app-server takes configuration.
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface GatewaySettings {
  // The whole file, as configuration for the thread.
  config: Record<string, JsonValue>;
  // The file's model_provider, which the thread runs on.
  modelProvider?: string;
  // The file's model, offered among the models of a session through the gateway.
  model?: string;
}

// The gateways folder in Codex's home, which CODEX_HOME moves.
export function defaultGatewaysDir(): string {
  const configured = process.env.CODEX_HOME;
  const home =
    configured !== undefined && configured !== '' ? configured : join(homedir(), '.codex');
  return join(home, 'gateways');
}

// The gateways in the folder, by name and in order; none when the folder does not exist.
export async function listGateways(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.toml')) continue;
    const name = entry.name.slice(0, -'.toml'.length);
    if (!GATEWAY_NAME.test(name)) continue;
    // A link counts when it leads to a file.
    if (entry.isFile() || (entry.isSymbolicLink() && (await isFile(join(dir, entry.name))))) {
      names.push(name);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

// The path of a gateway's file; throws for a name that cannot be a gateway's.
export function gatewayPath(dir: string, name: string): string {
  if (!GATEWAY_NAME.test(name)) throw new Error(`"${name}" is not a gateway name.`);
  return join(dir, `${name}.toml`);
}

// Reads and parses a gateway's file. Errors name the gateway and a place in the file, never its text.
export async function readGateway(dir: string, name: string): Promise<GatewaySettings> {
  const path = gatewayPath(dir, name);
  if (!(await isFile(path))) throw new Error(`The gateway "${name}" does not exist.`);
  let parsed: unknown;
  try {
    parsed = parse(await readFile(path, 'utf8'));
  } catch (error) {
    const place =
      error instanceof TomlError
        ? ` at line ${String(error.line)}, column ${String(error.column)}`
        : '';
    // eslint-disable-next-line preserve-caught-error -- the parser's error quotes the file, which may hold a token.
    throw new Error(`The gateway "${name}" is not valid TOML${place}.`);
  }
  const config = jsonObject(parsed, name, '');
  const { model_provider: modelProvider, model } = config;
  return {
    config,
    ...(typeof modelProvider === 'string' && modelProvider !== '' ? { modelProvider } : {}),
    ...(typeof model === 'string' && model !== '' ? { model } : {}),
  };
}

// The text with every string of a gateway's settings that could be a secret hidden, so that an error
// from Codex can never show a token from the file.
export function redact(text: string, settings: GatewaySettings | null): string {
  if (settings === null) return text;
  let redacted = text;
  for (const value of strings(settings.config)) {
    if (value.length >= 8) redacted = redacted.split(value).join('[hidden]');
  }
  return redacted;
}

function strings(value: JsonValue): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

function jsonObject(value: unknown, gateway: string, key: string): Record<string, JsonValue> {
  const json = jsonValue(value, gateway, key);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error(`The gateway "${gateway}" does not hold a table of settings.`);
  }
  return json;
}

// A parsed TOML value as JSON; dates become text. Errors name the setting, never its value.
function jsonValue(value: unknown, gateway: string, key: string): JsonValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, gateway, key));
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).map(([child, entry]): [string, JsonValue] => {
      const childKey = key === '' ? child : `${key}.${child}`;
      if (UNSAFE_KEYS.has(child)) {
        throw new Error(`The gateway "${gateway}" uses a key Codex cannot take: ${childKey}.`);
      }
      return [child, jsonValue(entry, gateway, childKey)];
    });
    return Object.fromEntries(entries);
  }
  throw new Error(`The gateway "${gateway}" has a value Codex cannot take at ${key}.`);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
