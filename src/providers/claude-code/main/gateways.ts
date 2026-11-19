import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A gateway is a Claude Code settings file named <name>.json in the gateways folder. The app lists these
// files and hands one to Claude Code by its path; it never opens them (ADR-0028).

// Letters, digits, dots, hyphens and underscores, starting with a letter or digit, so that a gateway's
// name can never lead outside the folder.
const GATEWAY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The gateways folder inside Claude Code's configuration folder, which CLAUDE_CONFIG_DIR moves.
export function defaultGatewaysDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const configDir =
    configured !== undefined && configured !== '' ? configured : join(homedir(), '.claude');
  return join(configDir, 'gateways');
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
    if (!entry.name.endsWith('.json')) continue;
    const name = entry.name.slice(0, -'.json'.length);
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
  return join(dir, `${name}.json`);
}

// The path of a gateway's file, which must exist.
export async function existingGatewayPath(dir: string, name: string): Promise<string> {
  const path = gatewayPath(dir, name);
  if (!(await isFile(path))) throw new Error(`The gateway "${name}" does not exist.`);
  return path;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
