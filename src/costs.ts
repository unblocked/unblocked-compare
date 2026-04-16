/**
 * Deterministic cost calculation from token counts.
 *
 * Pricing is hardcoded from published rate cards. No LLM involved.
 * Prices are per 1M tokens as of April 2026.
 */

interface PricingTier {
  inputPer1M: number;
  outputPer1M: number;
}

const PRICING: Record<string, PricingTier> = {
  // Anthropic
  "claude-opus-4-6": { inputPer1M: 15, outputPer1M: 75 },
  "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
  "claude-haiku-4-5-20251001": { inputPer1M: 0.8, outputPer1M: 4 },

  // OpenAI
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4.1": { inputPer1M: 2, outputPer1M: 8 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "o3": { inputPer1M: 10, outputPer1M: 40 },
  "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
};

export interface CostBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  pricingFound: boolean;
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): CostBreakdown {
  const pricing = PRICING[model];

  if (!pricing) {
    return {
      model,
      inputTokens,
      outputTokens,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      pricingFound: false,
    };
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;

  return {
    model,
    inputTokens,
    outputTokens,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    pricingFound: true,
  };
}

export function formatCost(cost: CostBreakdown): string {
  if (!cost.pricingFound) {
    return `$? (no pricing data for ${cost.model})`;
  }
  return `$${cost.totalCost.toFixed(4)}`;
}
