/**
 * model-router-chain
 * Smart LLM routing with automatic fallback, complexity scoring, and cost optimization.
 *
 * @author Igor Eduardo
 * @license MIT
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelConfig {
  id: string;
  provider: 'openai' | 'anthropic' | 'groq' | 'custom';
  model: string;
  apiKey: string;
  costPer1K: number;
  maxComplexity: 'low' | 'medium' | 'high';
  timeout: number;
  customFn?: (messages: Message[]) => Promise<string>;
}

export interface ModelRouterConfig {
  models: ModelConfig[];
  tierOverrides?: Record<string, { maxModel: string }>;
  complexityFn?: (messages: Message[]) => 'low' | 'medium' | 'high';
  onFallback?: (fromModel: string, toModel: string, error: Error) => void;
  onRoute?: (query: string, complexity: string, model: string) => void;
  temperature?: number;
}

export interface ChatOptions {
  messages: Message[];
  userTier?: string;
}

export interface ChatResponse {
  content: string;
  model: string;
  cost: number;
  latency: number;
  fallbackUsed: boolean;
  fallbackChain: string[];
}

export interface ComplexityScore {
  tokenCount: number;
  multiPart: boolean;
  domainDepth: number;
  contextRequired: number;
  final: 'low' | 'medium' | 'high';
}

interface ModelStats {
  count: number;
  cost: number;
  totalLatency: number;
  avgLatency: number;
}

export interface RouterStats {
  totalQueries: number;
  byModel: Record<string, ModelStats>;
  totalCost: number;
  costIfAllPowerful: number;
  savings: string;
  fallbackRate: string;
}

// ─── Core ────────────────────────────────────────────────────────────────────

const COMPLEXITY_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2 };

const MULTI_PART_SIGNALS = /\b(compare|versus|vs\.?|and also|additionally|moreover|as well as|difference between)\b/i;

const DOMAIN_TERMS = [
  'diagnosis', 'treatment', 'dosing', 'contraindication', 'prognosis',
  'pathophysiology', 'pharmacokinetics', 'etiology', 'comorbidity',
  'differential', 'algorithm', 'pipeline', 'architecture', 'infrastructure',
  'optimization', 'throughput', 'latency', 'scalability', 'compliance',
];

export class ModelRouter {
  private config: ModelRouterConfig;
  private stats: Map<string, { count: number; cost: number; totalLatency: number }>;
  private fallbackCount: number;
  private totalQueries: number;

  constructor(config: ModelRouterConfig) {
    if (!config.models.length) {
      throw new Error('At least one model must be configured');
    }

    // Sort models by cost (cheapest first)
    this.config = {
      temperature: 0.1,
      ...config,
      models: [...config.models].sort((a, b) => a.costPer1K - b.costPer1K),
    };

    this.stats = new Map();
    this.fallbackCount = 0;
    this.totalQueries = 0;

    for (const model of this.config.models) {
      this.stats.set(model.id, { count: 0, cost: 0, totalLatency: 0 });
    }
  }

  /**
   * Score the complexity of a message chain.
   */
  scoreComplexity(messages: Message[]): ComplexityScore {
    if (this.config.complexityFn) {
      const final = this.config.complexityFn(messages);
      return { tokenCount: 0, multiPart: false, domainDepth: 0, contextRequired: 0, final };
    }

    const lastMessage = messages[messages.length - 1]?.content ?? '';
    const allContent = messages.map(m => m.content).join(' ');

    // Token count (rough: ~4 chars per token)
    const tokenCount = Math.ceil(lastMessage.length / 4);

    // Multi-part detection
    const multiPart = MULTI_PART_SIGNALS.test(lastMessage) ||
      (lastMessage.match(/\?/g)?.length ?? 0) > 1;

    // Domain term density
    const lowerContent = lastMessage.toLowerCase();
    const domainHits = DOMAIN_TERMS.filter(term => lowerContent.includes(term)).length;
    const domainDepth = Math.min(domainHits / 4, 1);

    // Context depth (conversation length)
    const contextRequired = Math.min((messages.length - 1) / 5, 1);

    // Final scoring
    let score = 0;
    if (tokenCount > 100) score += 2;
    else if (tokenCount > 30) score += 1;

    if (multiPart) score += 2;
    if (domainDepth >= 0.75) score += 2;
    else if (domainDepth >= 0.25) score += 1;

    if (contextRequired >= 0.6) score += 1;

    let final: 'low' | 'medium' | 'high';
    if (score >= 4) final = 'high';
    else if (score >= 2) final = 'medium';
    else final = 'low';

    return { tokenCount, multiPart, domainDepth, contextRequired, final };
  }

  /**
   * Route a chat request to the optimal model with automatic fallback.
   */
  async chat(options: ChatOptions): Promise<ChatResponse> {
    const { messages, userTier } = options;
    const complexity = this.scoreComplexity(messages);
    const chain = this.buildFallbackChain(complexity.final, userTier);

    if (chain.length === 0) {
      throw new Error('No models available for this request');
    }

    const fallbackChain: string[] = [];
    let lastError: Error | null = null;

    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      fallbackChain.push(model.id);

      const isFallback = i > 0;
      if (isFallback && lastError && this.config.onFallback) {
        this.config.onFallback(chain[i - 1].id, model.id, lastError);
      }

      try {
        const start = Date.now();
        const content = await this.callModel(model, messages);
        const latency = Date.now() - start;
        const estimatedTokens = Math.ceil(content.length / 4);
        const cost = (estimatedTokens / 1000) * model.costPer1K;

        // Track stats
        this.totalQueries++;
        if (isFallback) this.fallbackCount++;

        const modelStats = this.stats.get(model.id)!;
        modelStats.count++;
        modelStats.cost += cost;
        modelStats.totalLatency += latency;

        if (this.config.onRoute) {
          this.config.onRoute(
            messages[messages.length - 1]?.content ?? '',
            complexity.final,
            model.id
          );
        }

        return {
          content,
          model: model.id,
          cost,
          latency,
          fallbackUsed: isFallback,
          fallbackChain,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
    }

    throw new Error(`All models failed. Last error: ${lastError?.message}`);
  }

  /**
   * Get usage statistics across all models.
   */
  getStats(): RouterStats {
    const byModel: Record<string, ModelStats> = {};
    let totalCost = 0;

    for (const [id, s] of this.stats) {
      byModel[id] = {
        count: s.count,
        cost: parseFloat(s.cost.toFixed(2)),
        totalLatency: s.totalLatency,
        avgLatency: s.count > 0 ? Math.round(s.totalLatency / s.count) : 0,
      };
      totalCost += s.cost;
    }

    // Calculate cost if all queries went to most expensive model
    const mostExpensive = this.config.models[this.config.models.length - 1];
    const costIfAllPowerful = totalCost > 0
      ? (this.totalQueries * (mostExpensive.costPer1K / 1000) * 500) // Assume avg 500 tokens
      : 0;

    const savings = costIfAllPowerful > 0
      ? (((costIfAllPowerful - totalCost) / costIfAllPowerful) * 100).toFixed(1) + '%'
      : '0%';

    const fallbackRate = this.totalQueries > 0
      ? ((this.fallbackCount / this.totalQueries) * 100).toFixed(1) + '%'
      : '0%';

    return {
      totalQueries: this.totalQueries,
      byModel,
      totalCost: parseFloat(totalCost.toFixed(2)),
      costIfAllPowerful: parseFloat(costIfAllPowerful.toFixed(2)),
      savings,
      fallbackRate,
    };
  }

  // ─── Private: Chain Building ────────────────────────────────────────────

  private buildFallbackChain(complexity: 'low' | 'medium' | 'high', userTier?: string): ModelConfig[] {
    let models = [...this.config.models];

    // Apply tier restriction
    if (userTier && this.config.tierOverrides?.[userTier]) {
      const maxModelId = this.config.tierOverrides[userTier].maxModel;
      const maxIndex = models.findIndex(m => m.id === maxModelId);
      if (maxIndex >= 0) {
        models = models.slice(0, maxIndex + 1);
      }
    }

    // Find cheapest model that handles this complexity
    const complexityLevel = COMPLEXITY_ORDER[complexity];
    const startIndex = models.findIndex(
      m => COMPLEXITY_ORDER[m.maxComplexity] >= complexityLevel
    );

    if (startIndex < 0) {
      // No model fits — use the most capable available
      return [models[models.length - 1]];
    }

    // Build chain: starting model + all higher-capability models as fallback
    return models.slice(startIndex);
  }

  // ─── Private: Model Calling ─────────────────────────────────────────────

  private async callModel(model: ModelConfig, messages: Message[]): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), model.timeout);

    try {
      if (model.customFn) {
        return await model.customFn(messages);
      }

      switch (model.provider) {
        case 'openai':
          return await this.callOpenAI(model, messages, controller.signal);
        case 'anthropic':
          return await this.callAnthropic(model, messages, controller.signal);
        case 'groq':
          return await this.callGroq(model, messages, controller.signal);
        default:
          throw new Error(`Unsupported provider: ${model.provider}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async callOpenAI(model: ModelConfig, messages: Message[], signal: AbortSignal): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify({
        model: model.model,
        messages,
        temperature: this.config.temperature,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  private async callAnthropic(model: ModelConfig, messages: Message[], signal: AbortSignal): Promise<string> {
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystemMsgs = messages.filter(m => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: model.model,
      max_tokens: 4096,
      messages: nonSystemMsgs,
      temperature: this.config.temperature,
    };

    if (systemMsg) {
      body.system = systemMsg.content;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': model.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.content[0].text;
  }

  private async callGroq(model: ModelConfig, messages: Message[], signal: AbortSignal): Promise<string> {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify({
        model: model.model,
        messages,
        temperature: this.config.temperature,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Groq API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }
}
