import { describe, expect, it } from 'vitest';
import { effortInUse, effortToSet, modelInUse, startingEffort, titleEffort } from './efforts';
import type { ModelOption } from './events';

const model = (efforts: string[], defaultEffort?: string): ModelOption => ({
  id: 'm',
  label: 'M',
  efforts,
  ...(defaultEffort === undefined ? {} : { defaultEffort }),
});

describe('startingEffort', () => {
  it('is medium wherever the model takes it, whatever its own default', () => {
    expect(startingEffort(model(['low', 'medium', 'high'], 'high'))).toBe('medium');
  });

  it('is the model’s own default where it has no medium', () => {
    expect(startingEffort(model(['low', 'high'], 'high'))).toBe('high');
  });

  it('is the level nearest medium where the model names no default, the lower of two as near', () => {
    expect(startingEffort(model(['low', 'max']))).toBe('low');
    expect(startingEffort(model(['high', 'max']))).toBe('high');
    expect(startingEffort(model(['low', 'high']))).toBe('low');
    expect(startingEffort(model(['minimal', 'xhigh']))).toBe('minimal');
  });

  it('is the model’s first level where it names none the app knows, and none for a model without', () => {
    expect(startingEffort(model(['turbo', 'deep']))).toBe('turbo');
    expect(startingEffort(model([]))).toBeNull();
    expect(startingEffort(undefined)).toBeNull();
  });
});

describe('effortToSet', () => {
  it('sets nothing where the effort the session runs with is known', () => {
    expect(effortToSet(model(['low', 'medium']), 'low')).toBeNull();
    // A null effort is the model's own default, where the provider names it.
    expect(effortToSet(model(['low', 'medium'], 'low'), null)).toBeNull();
    // One the provider runs that the model does not list stays the provider's.
    expect(effortToSet(model(['low', 'medium']), 'max')).toBeNull();
  });

  it('sets the starting effort where the session has none and the provider names no default', () => {
    expect(effortToSet(model(['low', 'medium', 'high']), null)).toBe('medium');
    expect(effortToSet(model(['low', 'high']), undefined)).toBe('low');
  });

  it('sets nothing for a model not known yet or one without effort', () => {
    expect(effortToSet(undefined, null)).toBeNull();
    expect(effortToSet(model([]), null)).toBeNull();
  });
});

describe('effortInUse and modelInUse', () => {
  it('takes the effort set, or else the model’s own default', () => {
    expect(effortInUse(model(['low'], 'low'), 'high')).toBe('high');
    expect(effortInUse(model(['low'], 'low'), null)).toBe('low');
    expect(effortInUse(model(['low']), null)).toBeNull();
  });

  it('takes the model set, or else the provider’s default', () => {
    const models: ModelOption[] = [
      { id: 'a', label: 'A', efforts: [] },
      { id: 'b', label: 'B', efforts: [], default: true },
    ];
    expect(modelInUse(models, 'a')?.id).toBe('a');
    expect(modelInUse(models, null)?.id).toBe('b');
    expect(modelInUse(models, 'gone')).toBeUndefined();
    expect(modelInUse(undefined, 'a')).toBeUndefined();
  });
});

describe('titleEffort', () => {
  it('is low where the model takes it, otherwise its lowest level, and none without levels', () => {
    expect(titleEffort(model(['low', 'medium', 'high']))).toBe('low');
    expect(titleEffort(model(['high', 'medium', 'xhigh']))).toBe('medium');
    expect(titleEffort(model(['minimal', 'medium']))).toBe('minimal');
    expect(titleEffort(model(['turbo', 'deep']))).toBe('turbo');
    expect(titleEffort(model([]))).toBeNull();
    expect(titleEffort(undefined)).toBeNull();
  });
});
