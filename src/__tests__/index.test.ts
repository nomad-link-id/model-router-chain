import { describe, it, expect } from 'vitest';
import { ModelRouter } from '../index.js';
import type { ModelConfig, Message } from '../index.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeModels(): ModelConfig[] {
  return [
    {
      id: 'cheap',
      provider: 'custom',
      model: 'cheap-model',
      apiKey: 'test',
      costPer1K: 0,
      maxComplexity: 'low',
      timeout: 5000,
      customFn: async () => 'cheap response',
    },
    {
      id: 'mid',
      provider: 'custom',
      model: 'mid-model',
      apiKey: 'test',
      costPer1K: 2.0,
      maxComplexity: 'medium',
      timeout: 10000,
      customFn: async () => 'mid response',
    },
    {
      id: 'expensive',
      provider: 'custom',
      model: 'expensive-model',
      apiKey: 'test',
      costPer1K: 9.0,
      maxComplexity: 'high',
      timeout: 30000,
      customFn: async () => 'expensive response',
    },
  ];
}

function makeRouter(overrides?: Partial<{ models: ModelConfig[] }>) {
  return new ModelRouter({ models: overrides?.models ?? makeModels() });
}

function userMsg(content: string): Message[] {
  return [{ role: 'user', content }];
}

// ─── Complexity Scoring ───────────────────────────────────────────────────────

describe('scoreComplexity', () => {
  it('scores a simple short query as low', () => {
    const router = makeRouter();
    const score = router.scoreComplexity(userMsg('What is metformin?'));

    expect(score.final).toBe('low');
    expect(score.multiPart).toBe(false);
    expect(score.tokenCount).toBeLessThanOrEqual(30);
  });

  it('scores a multi-part query with domain terms as high', () => {
    const router = makeRouter();
    const query = 'Compare the diagnosis and treatment of heart failure versus renal failure, '
      + 'including dosing protocols, contraindication checks, and prognosis factors '
      + 'for patients with comorbidity and differential diagnosis considerations';
    const score = router.scoreComplexity(userMsg(query));

    expect(score.final).toBe('high');
    expect(score.multiPart).toBe(true);
    expect(score.domainDepth).toBeGreaterThan(0);
  });

  it('scores a medium complexity query correctly', () => {
    const router = makeRouter();
    // 30+ tokens with domain terms -> triggers medium
    const query = 'What is the recommended treatment and dosing approach for managing this diagnosis given the patient current prognosis and extended clinical history over the past several years of observation?';
    const score = router.scoreComplexity(userMsg(query));

    expect(['medium', 'high']).toContain(score.final);
    expect(score.tokenCount).toBeGreaterThan(30);
  });
});

// ─── Routing ──────────────────────────────────────────────────────────────────

describe('routeToModel', () => {
  it('routes low complexity query to cheapest model', async () => {
    const router = makeRouter();
    const result = await router.chat({
      messages: userMsg('Hello'),
    });

    expect(result.model).toBe('cheap');
    expect(result.content).toBe('cheap response');
    expect(result.fallbackUsed).toBe(false);
  });

  it('routes high complexity query to expensive model', async () => {
    const router = makeRouter();
    const query = 'Compare the diagnosis and treatment of heart failure versus renal failure, '
      + 'including dosing protocols, contraindication checks, and prognosis for patients '
      + 'with comorbidity and differential diagnosis considerations across multiple conditions';
    const result = await router.chat({
      messages: userMsg(query),
    });

    expect(result.model).toBe('expensive');
    expect(result.content).toBe('expensive response');
  });
});

// ─── Fallback Chain ───────────────────────────────────────────────────────────

describe('fallback', () => {
  it('falls back to next model when primary fails', async () => {
    let callCount = 0;
    const models = makeModels();
    // Make cheap model fail
    models[0].customFn = async () => {
      callCount++;
      throw new Error('model unavailable');
    };

    const router = makeRouter({ models });
    const result = await router.chat({
      messages: userMsg('Hello'),
    });

    expect(callCount).toBe(1); // cheap was tried
    expect(result.model).toBe('mid'); // fell back to mid
    expect(result.content).toBe('mid response');
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackChain).toContain('cheap');
    expect(result.fallbackChain).toContain('mid');
  });

  it('falls back through entire chain if needed', async () => {
    const models = makeModels();
    models[0].customFn = async () => { throw new Error('fail'); };
    models[1].customFn = async () => { throw new Error('fail'); };

    const router = makeRouter({ models });
    const result = await router.chat({
      messages: userMsg('Hello'),
    });

    expect(result.model).toBe('expensive');
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackChain).toEqual(['cheap', 'mid', 'expensive']);
  });

  it('throws when all models fail', async () => {
    const models = makeModels();
    models[0].customFn = async () => { throw new Error('fail'); };
    models[1].customFn = async () => { throw new Error('fail'); };
    models[2].customFn = async () => { throw new Error('fail'); };

    const router = makeRouter({ models });

    await expect(router.chat({ messages: userMsg('Hello') }))
      .rejects.toThrow('All models failed');
  });
});

// ─── Stats Tracking ───────────────────────────────────────────────────────────

describe('stats', () => {
  it('tracks query count and model usage', async () => {
    const router = makeRouter();
    await router.chat({ messages: userMsg('Hello') });
    await router.chat({ messages: userMsg('Hi there') });

    const stats = router.getStats();
    expect(stats.totalQueries).toBe(2);
    expect(stats.byModel.cheap.count).toBe(2);
  });
});
