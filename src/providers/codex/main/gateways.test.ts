import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gatewayLaunchArgs, gatewayPath, listGateways, readGateway, redact } from './gateways';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-gateways-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Codex gateways', () => {
  it('lists the TOML files with gateway names, in order, following links to files', async () => {
    writeFileSync(join(dir, 'work.toml'), '');
    writeFileSync(join(dir, 'Home-2.toml'), '');
    writeFileSync(join(dir, 'notes.json'), '');
    writeFileSync(join(dir, '.hidden.toml'), '');
    mkdirSync(join(dir, 'folder.toml'));
    symlinkSync(join(dir, 'work.toml'), join(dir, 'linked.toml'));
    symlinkSync(join(dir, 'missing'), join(dir, 'dangling.toml'));
    expect(await listGateways(dir)).toEqual(['Home-2', 'linked', 'work']);
    expect(await listGateways(join(dir, 'absent'))).toEqual([]);
  });

  it('refuses names that could lead outside the folder', () => {
    expect(gatewayPath(dir, 'work')).toBe(join(dir, 'work.toml'));
    expect(() => gatewayPath(dir, '../work')).toThrow('not a gateway name');
    expect(() => gatewayPath(dir, '')).toThrow('not a gateway name');
  });

  it('reads a profile file as configuration, with its provider, model and effort', async () => {
    writeFileSync(
      join(dir, 'work.toml'),
      [
        'model = "gpt-test"',
        'model_provider = "proxy"',
        'model_reasoning_effort = "low"',
        'checked = 2026-10-26T10:00:00Z',
        '[model_providers.proxy]',
        'base_url = "https://proxy.example.com/v1"',
        'experimental_bearer_token = "secret-token-value"',
      ].join('\n'),
    );
    expect(await readGateway(dir, 'work')).toEqual({
      config: {
        model: 'gpt-test',
        model_provider: 'proxy',
        model_reasoning_effort: 'low',
        checked: '2026-10-26T10:00:00.000Z',
        model_providers: {
          proxy: {
            base_url: 'https://proxy.example.com/v1',
            experimental_bearer_token: 'secret-token-value',
          },
        },
      },
      modelProvider: 'proxy',
      model: 'gpt-test',
      effort: 'low',
    });
  });

  it('names the place of a TOML error, never the file’s text', async () => {
    writeFileSync(join(dir, 'broken.toml'), 'token = "secret-token-value"\nthis is not toml\n');
    const reading = readGateway(dir, 'broken');
    await expect(reading).rejects.toThrow(/^The gateway "broken" is not valid TOML at line 2/);
    await expect(reading).rejects.not.toThrow(/secret/);
    await expect(readGateway(dir, 'gone')).rejects.toThrow('does not exist');
  });

  it('refuses a value Codex cannot take and a key that would change the object', async () => {
    writeFileSync(join(dir, 'odd.toml'), 'limit = inf\n');
    await expect(readGateway(dir, 'odd')).rejects.toThrow('cannot take at limit');
    writeFileSync(join(dir, 'proto.toml'), '[model_providers.__proto__]\nbase_url = "x"\n');
    await expect(readGateway(dir, 'proto')).rejects.toThrow('model_providers.__proto__');
  });

  it('hides the file’s longer strings in text, such as Codex’s errors', async () => {
    writeFileSync(
      join(dir, 'work.toml'),
      'model = "gpt"\nexperimental_bearer_token = "secret-token-value"\n',
    );
    const settings = await readGateway(dir, 'work');
    expect(redact('bad token secret-token-value for gpt', settings)).toBe(
      'bad token [hidden] for gpt',
    );
    expect(redact('unchanged', null)).toBe('unchanged');
  });

  it('names the gateway’s provider for its app-server’s command line, defined by its id alone where the file defines it', async () => {
    const launchOf = async (name: string, lines: string[]) => {
      writeFileSync(join(dir, `${name}.toml`), lines.join('\n'));
      return gatewayLaunchArgs(name, await readGateway(dir, name));
    };
    const defined = await launchOf('work', [
      'model_provider = "proxy"',
      '[model_providers.proxy]',
      'base_url = "https://proxy.example.com/v1"',
      'experimental_bearer_token = "secret-token-value"',
    ]);
    expect(defined).toEqual([
      '-c',
      'model_provider="proxy"',
      '-c',
      'model_providers.proxy.name="proxy"',
    ]);
    // A provider defined elsewhere, such as Codex's own or one in Codex's own settings, by its id only.
    expect(await launchOf('local', ['model_provider = "ollama"', 'model = "llama"'])).toEqual([
      '-c',
      'model_provider="ollama"',
    ]);
    expect(
      await launchOf('bedrock', [
        'model_provider = "amazon-bedrock"',
        '[model_providers.amazon-bedrock]',
        'region = "eu-west-1"',
      ]),
    ).toEqual(['-c', 'model_provider="amazon-bedrock"']);
    expect(await launchOf('model', ['model = "gpt-other"'])).toEqual([]);
    await expect(
      launchOf('dotted', ['model_provider = "my.proxy"', '[model_providers."my.proxy"]']),
    ).rejects.toThrow('The gateway "dotted" defines a provider whose id Codex CLI cannot take');
  });
});
