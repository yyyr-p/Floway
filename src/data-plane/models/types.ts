import type { ModelPricing } from '../providers/types.ts';

// Public DTO served at /v1/models and /models. Single superset shape — OpenAI's
// and Anthropic's /models field names do not overlap, so one payload satisfies
// both client shapes.
export interface PublicModel {
  // OpenAI fields
  id: string;
  object: 'model';
  owned_by?: string;
  created?: number;
  // Anthropic fields
  type: 'model';
  display_name: string;
  created_at?: string;
  // Non-standard extra fields below.
  limits: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
  supports_generation: boolean;
  cost?: ModelPricing;
}

export interface PublicModelsResponse {
  // OpenAI container
  object: 'list';
  // Anthropic container
  has_more: false;
  first_id: string | null;
  last_id: string | null;
  data: PublicModel[];
}
