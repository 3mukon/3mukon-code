import { z } from 'zod';
import { PRESENTATION_LIMITS } from '../shared/presentation';

const id = z.string().min(1).max(PRESENTATION_LIMITS.idLength);
const version = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const box = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict();
const state = z
  .object({
    presentationId: id,
    owner: id,
    version,
    boxes: z.array(box.nullable()).min(1).max(PRESENTATION_LIMITS.items),
  })
  .strict();
const used = z.union([
  z.object({ kind: z.literal('browser'), tabId: id }).strict(),
  z.object({ kind: z.literal('computer'), targetId: id }).strict(),
]);
export const presentationRendererSchema = z.union([
  z
    .object({
      kind: z.literal('snapshot'),
      epoch: id,
      sessionPanels: z.array(z.object({ owner: id, box }).strict()).max(512),
      presentations: z.array(state).max(512),
    })
    .strict(),
  z.object({ kind: z.literal('changed'), epoch: id, state }).strict(),
  z
    .object({ kind: z.literal('show'), epoch: id, requestId: id, owner: id, presentationId: id })
    .strict(),
  z
    .object({ kind: z.literal('show'), epoch: id, requestId: id, owner: id, content: used })
    .strict(),
  z.object({ kind: z.literal('applied'), commandId: id, epoch: id, state }).strict(),
  z
    .object({
      kind: z.literal('refused'),
      commandId: id,
      epoch: id,
      presentationId: id,
      code: z.enum([
        'stale-epoch',
        'command-conflict',
        'invalid-command',
        'wrong-owner',
        'presentation-unknown',
        'presentation-changed',
        'item-count-mismatch',
        'unsaved-changes',
        'busy',
      ]),
      state: state.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('cancelled'), commandId: id, epoch: id }).strict(),
]);
