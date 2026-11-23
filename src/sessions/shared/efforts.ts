import type { ModelOption, ReasoningEffort } from './events';

// The levels of reasoning effort the providers name, from the least to the most.
const LEVELS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// The effort a session starts with unless the user chooses another, whatever the provider's own
// default: medium wherever the model takes it, as every provider's models that take an effort do;
// otherwise the model's own default where the provider names it; otherwise the level the model
// takes nearest to medium, the lower of two as near, or its first where it names none the app
// knows. Null for a model that takes no effort, or one not known yet.
export function startingEffort(model: ModelOption | undefined): ReasoningEffort | null {
  if (model === undefined || model.efforts.length === 0) return null;
  if (model.efforts.includes('medium')) return 'medium';
  if (model.defaultEffort !== undefined && model.efforts.includes(model.defaultEffort)) {
    return model.defaultEffort;
  }
  const medium = LEVELS.indexOf('medium');
  const known = model.efforts.filter((level) => LEVELS.includes(level));
  const nearest = known.reduce<ReasoningEffort | undefined>((best, level) => {
    if (best === undefined) return level;
    const [distance, bestDistance] = [level, best].map((one) =>
      Math.abs(LEVELS.indexOf(one) - medium),
    ) as [number, number];
    if (distance !== bestDistance) return distance < bestDistance ? level : best;
    return LEVELS.indexOf(level) < LEVELS.indexOf(best) ? level : best;
  }, undefined);
  return nearest ?? model.efforts[0] ?? null;
}

// The effort a session runs with at the effort it is set to: that one, or for none the model's own
// default where the provider names it; null where neither is known.
export function effortInUse(
  model: ModelOption | undefined,
  effort: ReasoningEffort | null | undefined,
): ReasoningEffort | null {
  return effort ?? model?.defaultEffort ?? null;
}

// The effort a running session should be set to so that the effort it runs with is known: the
// starting effort for the model, where the session has none and the provider names no default for
// the model, as Claude Code names none; otherwise null, as nothing needs setting. An effort the
// provider runs that the model does not list, such as one its own configuration sets, is the
// provider's to keep. A model not known yet, or one that takes no effort, needs none.
export function effortToSet(
  model: ModelOption | undefined,
  effort: ReasoningEffort | null | undefined,
): ReasoningEffort | null {
  if (model === undefined || model.efforts.length === 0) return null;
  return effortInUse(model, effort) === null ? startingEffort(model) : null;
}

// The model a session runs: the one set, or for none the provider's default; undefined while the
// models are not known, or where the list does not hold it.
export function modelInUse(
  models: readonly ModelOption[] | undefined,
  model: string | null | undefined,
): ModelOption | undefined {
  return models?.find((entry) => (model == null ? entry.default === true : entry.id === model));
}

// The effort a title is written at with the model: low where the model takes it, otherwise its
// lowest level the app knows, or its first where it names none the app knows; null for a model that
// takes no effort, or one not known, so that the provider's default stands.
export function titleEffort(model: ModelOption | undefined): ReasoningEffort | null {
  if (model === undefined || model.efforts.length === 0) return null;
  if (model.efforts.includes('low')) return 'low';
  const known = model.efforts.filter((level) => LEVELS.includes(level));
  const lowest = known.reduce<ReasoningEffort | undefined>(
    (best, level) =>
      best === undefined || LEVELS.indexOf(level) < LEVELS.indexOf(best) ? level : best,
    undefined,
  );
  return lowest ?? model.efforts[0] ?? null;
}
