import { z } from 'zod';
import type { ARTIFACT_LIMITS, PRESENTATION_LIMITS } from '../../panels/shared/presentation';
import type { PanelExecutor, PanelRequest } from '../../panels/shared/presentation-host';
import type { AutomationTool } from './execution';

// Feature values arrive through app composition; this module imports only the public panel types.
export function panelTools(
  port: PanelExecutor,
  limits: { artifact: typeof ARTIFACT_LIMITS; presentation: typeof PRESENTATION_LIMITS },
): AutomationTool[] {
  const a = limits.artifact;
  const p = limits.presentation;
  const id = z.string().min(1).max(p.idLength);
  const title = z.string().trim().min(1).max(p.titleLength);
  const version = z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1);
  const placement = z
    .object({
      side: z.enum(['left', 'right', 'top', 'bottom']),
      direction: z.enum(['row', 'column']),
    })
    .strict()
    .default({ side: 'right', direction: 'row' })
    .describe(
      'The side of your session’s panel the presentation opens on, and whether its panels lie side by side in a row or stacked in a column.',
    );
  const artifact = z.discriminatedUnion('format', [
    z
      .object({ format: z.literal('markdown'), title, text: z.string().max(a.markdownBytes) })
      .strict(),
    z
      .object({
        format: z.literal('image'),
        title,
        mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
        data: z.string().max(a.imageBase64Bytes),
        width: z.number().int().positive().max(a.imageEdge),
        height: z.number().int().positive().max(a.imageEdge),
      })
      .strict(),
    z
      .object({
        format: z.literal('table'),
        title,
        columns: z.array(z.string().max(a.tableBytes)).min(1).max(a.tableColumns),
        rows: z
          .array(
            z
              .array(z.union([z.string().max(a.tableBytes), z.number(), z.boolean(), z.null()]))
              .max(a.tableColumns),
          )
          .max(a.tableRows),
      })
      .strict(),
  ]);
  const items = z
    .array(
      z.union([
        z.object({ kind: z.literal('file'), path: id.startsWith('/') }).strict(),
        z.object({ kind: z.literal('browser'), tabId: id }).strict(),
        z.object({ kind: z.literal('computer'), targetId: id }).strict(),
        z.object({ kind: z.literal('artifact'), artifactId: id }).strict(),
        z.object({ kind: z.literal('artifact'), artifact }).strict(),
      ]),
    )
    .min(1)
    .max(p.items)
    .describe(
      `What the presentation’s panels show, one panel each, in order, at most ${String(p.items)}, each shown once: a file by its absolute path; a result you make here, as Markdown, an image in base64 with its size in pixels, or a table of named columns and rows; an artifactId from an earlier result; or a browser tab or computer target by its handle.`,
    );
  function tool(
    name: string,
    description: string,
    inputSchema: z.ZodObject,
    request: (args: Record<string, unknown>) => PanelRequest,
  ): AutomationTool {
    return {
      name,
      description,
      family: 'panel',
      inputSchema,
      maxArgumentBytes: 16 * 1024 * 1024,
      availability: { tools: 'ready', images: 'unknown' },
      plan: () => ({
        operation: null,
        effect: 'present',
        delivery: 'background',
        mayActivate: false,
      }),
      execute: (args, context) =>
        port.execute(context.owner, context.callId, request(args), context.signal),
    };
  }
  const seen = version.describe(
    'The presentation’s version as you last saw it, in a result, a notice or the list; 0 for one you have not presented yet.',
  );
  const presentation = id.describe('The presentation’s id, from a result, a notice or the list.');
  const list = z
    .object({
      offset: z
        .number()
        .int()
        .nonnegative()
        .max(1024)
        .optional()
        .describe('Where to go on from: the nextOffset of the previous page.'),
    })
    .strict();
  const present = z
    .object({
      reuseKey: id
        .max(128)
        .describe(
          'Your own name for what you present, which stays the same each time you present it, so that it replaces itself in place.',
        ),
      version: seen,
      title: title.describe('What the presentation is, as the user will hear it announced.'),
      items,
      placement,
    })
    .strict();
  const update = z.object({ presentationId: presentation, version: seen, title, items }).strict();
  const arrange = z.object({ presentationId: presentation, version: seen, placement }).strict();
  const close = z
    .object({
      presentationId: presentation,
      version: seen,
    })
    .strict();
  const closeTool = tool(
    'panel_close',
    'Close your presentation’s panels. Nothing it shows ends: files, pages and applications stay as they are. A panel with unsaved changes stays open, and terminals, sessions and the user’s own panels are the user’s to close.',
    close,
    (args) => ({ kind: 'close', ...close.parse(args) }),
  );
  return [
    tool(
      'panel_list',
      'List where your presentations stand now: each one’s id, reuse key, title and version, and where each of its panels lies, as fractions of the panel area, or null where closed; and your session’s own panels. A presentation whose last change went unanswered is listed under unresolved, with its version: present it again at that version to settle it. Pass nextOffset to read on. It is the current state, not a history.',
      list,
      (args) => ({ kind: 'list', ...list.parse(args) }),
    ),
    tool(
      'panel_present',
      'Show the user something beside your session’s panel, without taking the keyboard focus: a result worth reading, a comparison of a few items side by side, a decision for the user to make, or a handoff. Do not present routine observations or intermediate steps; your session’s activity records your work. Presenting again with the same reuseKey replaces the presentation in place, at the version you last saw. A present opens all of its panels, also ones the user closed: when the user has closed a presentation, do not present it again without a good reason, such as the user asking for it. A refusal gives the presentation’s current state to try again from.',
      present,
      (args) => ({ kind: 'present', ...present.parse(args) }),
    ),
    tool(
      'panel_update',
      'Change what your presentation shows, in place, and its title: one item for each of its panels, in order, at the version you last saw. It opens and closes nothing, so a panel the user closed stays closed, and moves nothing. To change how many items it has, present it again.',
      update,
      (args) => ({ kind: 'update', ...update.parse(args) }),
    ),
    tool(
      'panel_arrange',
      'Place your presentation’s open panels again, on a side of your session’s panel, side by side or stacked, at its current version. Once the user has moved or closed its panels, an earlier version is refused with the current state.',
      arrange,
      (args) => ({ kind: 'arrange', ...arrange.parse(args) }),
    ),
    closeTool,
  ];
}
