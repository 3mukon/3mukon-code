import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ARTIFACT_LIMITS, PRESENTATION_LIMITS } from '../../panels/shared/presentation';
import { panelTools } from '../../toolset/main/panel-tools';
import { sessionTools } from '../../toolset/main/session-tools';
import { browserTools } from './browser-automation';
import { computerAutomation } from './computer-automation';

// Every built-in tool as the toolset lists it, built without its backends, which listing never reaches.
function builtInTools() {
  return [
    ...browserTools({} as never, {} as never),
    ...computerAutomation({} as never, () => ({}) as never).tools,
    ...panelTools({} as never, { artifact: ARTIFACT_LIMITS, presentation: PRESENTATION_LIMITS }),
    ...sessionTools(),
  ];
}

describe('the built-in tools’ definitions', () => {
  // A provider's tool search loads a tool's schema only once it has found the tool, so the schema
  // alone has to say what each parameter holds.
  it('describe every parameter they take', () => {
    const undescribed = builtInTools().flatMap((tool) => {
      const schema = z.toJSONSchema(tool.inputSchema) as {
        properties?: Record<string, { description?: string }>;
      };
      return Object.entries(schema.properties ?? {})
        .filter(([, property]) => (property.description ?? '').trim() === '')
        .map(([name]) => `${tool.name}.${name}`);
    });
    expect(undescribed).toEqual([]);
  });

  it('say what each does to its surroundings, and lead their descriptions with what each does', () => {
    for (const tool of builtInTools()) {
      expect(typeof tool.annotations.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations.openWorldHint, tool.name).toBe('boolean');
      // The first sentence carries what a search for the tool matches first.
      const first = tool.description.split(/(?<=[.:;])\s/)[0] ?? '';
      expect(first.length, tool.name).toBeLessThanOrEqual(240);
    }
  });
});
