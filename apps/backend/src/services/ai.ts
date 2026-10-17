import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { AIReview, AIReviewSchema, ExpenseClaim, PolicySection } from '../types.js';
import { normalizeText } from './validation.js';

const confidenceThreshold = 0.7;
const preferredGeminiModels = [
  'gemini-3.1-flash-lite-preview',
  'gemini-3.1-flash-preview',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

const geminiReviewResponseSchema = {
  type: 'OBJECT',
  properties: {
    suggestedCategory: {
      type: 'STRING',
      enum: ['Travel', 'Meals', 'Software', 'Office', 'Training', 'Mileage', 'Accommodation', 'Other'],
    },
    confidence: { type: 'NUMBER' },
    classificationUncertain: { type: 'BOOLEAN' },
    reviewStatus: {
      type: 'STRING',
      enum: ['potentially_compliant', 'clarification_required', 'needs_attention'],
    },
    summary: { type: 'STRING' },
    findings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          code: { type: 'STRING' },
          severity: { type: 'STRING', enum: ['info', 'warning', 'error', 'critical'] },
          message: { type: 'STRING' },
          field: { type: 'STRING' },
          policySectionIds: { type: 'ARRAY', items: { type: 'STRING' } },
          evidence: { type: 'STRING' },
          requiresClarification: { type: 'BOOLEAN' },
        },
        required: ['code', 'severity', 'message', 'policySectionIds', 'requiresClarification'],
      },
    },
    missingInformation: { type: 'ARRAY', items: { type: 'STRING' } },
    clarificationQuestions: { type: 'ARRAY', items: { type: 'STRING' } },
    limitations: { type: 'ARRAY', items: { type: 'STRING' } },
    policySectionIds: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: [
    'suggestedCategory',
    'confidence',
    'classificationUncertain',
    'reviewStatus',
    'summary',
    'findings',
    'missingInformation',
    'clarificationQuestions',
    'limitations',
    'policySectionIds',
  ],
};

type GeminiFailureCategory =
  | 'invalid_api_key'
  | 'access_denied'
  | 'quota_or_rate_limit'
  | 'model_unavailable'
  | 'request_rejected'
  | 'provider_unavailable'
  | 'network_error'
  | 'invalid_response';

class GeminiProviderError extends Error {
  constructor(
    readonly category: GeminiFailureCategory,
    readonly providerStatus?: number,
  ) {
    super(category);
  }
}

const errorProperty = (error: unknown, key: string): unknown => (
  typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[key]
    : undefined
);

const classifyGeminiError = (error: unknown): GeminiProviderError => {
  if (error instanceof GeminiProviderError) return error;

  const response = errorProperty(error, 'response');
  const rawStatus = errorProperty(error, 'status')
    ?? errorProperty(error, 'statusCode')
    ?? errorProperty(response, 'status');
  const status = typeof rawStatus === 'number' ? rawStatus : undefined;
  const rawCode = errorProperty(error, 'code');
  const code = typeof rawCode === 'string' ? rawCode.toLowerCase() : '';
  const rawMessage = errorProperty(error, 'message');
  const message = typeof rawMessage === 'string' ? rawMessage.toLowerCase() : '';

  if (status === 401 || code.includes('api_key_invalid') || code.includes('invalid_api_key')) {
    return new GeminiProviderError('invalid_api_key', status);
  }
  if (status === 400 && (message.includes('api key not valid') || message.includes('invalid api key'))) {
    return new GeminiProviderError('invalid_api_key', status);
  }
  if (status === 400) return new GeminiProviderError('request_rejected', status);
  if (status === 403) return new GeminiProviderError('access_denied', status);
  if (status === 429) return new GeminiProviderError('quota_or_rate_limit', status);
  if (status === 404) return new GeminiProviderError('model_unavailable', status);
  if (status !== undefined && status >= 500) {
    return new GeminiProviderError('provider_unavailable', status);
  }
  return new GeminiProviderError('network_error', status);
};

const geminiFailureMessage = (failure: GeminiProviderError) => {
  switch (failure.category) {
    case 'invalid_api_key':
      return 'Gemini rejected GEMINI_API_KEY. Add a valid Gemini API key to apps/backend/.env and restart the backend.';
    case 'access_denied':
      return 'Gemini denied access to this API or model. Check the key restrictions and Google AI project configuration.';
    case 'quota_or_rate_limit':
      return 'Gemini quota or rate limit reached. Check the Google AI project quota and billing settings.';
    case 'model_unavailable':
      return 'No supported Gemini text-generation model is available to this API key.';
    case 'request_rejected':
      return 'Gemini rejected the request. Check the selected model and request configuration.';
    case 'provider_unavailable':
      return 'Gemini is temporarily unavailable. Retry the AI review later.';
    case 'invalid_response':
      return 'Gemini returned an empty or invalid review response; reviewer attention is required.';
    case 'network_error':
      return 'Gemini could not be reached. Check the network connection and retry.';
  }
};

const createGeminiClient = (apiKey: string) => new GoogleGenAI({
  apiKey,
  httpOptions: { timeout: 30000 },
});

const getAvailableGeminiModels = async (client: GoogleGenAI): Promise<string[]> => {
  const models = await client.models.list({ config: { pageSize: 100 } });
  const availableModels: string[] = [];

  for await (const model of models) {
    if (!model.name || !model.supportedActions?.includes('generateContent')) continue;
    const modelId = model.name.replace(/^models\//, '');
    if (/tts|image|audio|live|transcrib|embedding|veo/i.test(modelId)) continue;
    availableModels.push(model.name);
  }

  const modelId = (name: string) => name.replace(/^models\//, '');
  const prioritized = preferredGeminiModels
    .map((preferred) => availableModels.find((name) => modelId(name) === preferred))
    .filter((name): name is string => Boolean(name));
  const flashModels = availableModels.filter((name) => /^gemini-.*flash(?:-|$)/i.test(modelId(name)));
  const otherModels = availableModels.filter((name) => !prioritized.includes(name) && !flashModels.includes(name));
  const candidates = [...prioritized, ...flashModels, ...otherModels].slice(0, 3);
  if (candidates.length === 0) throw new GeminiProviderError('model_unavailable', 404);
  return candidates;
};

const generateGeminiContent = async (
  client: GoogleGenAI,
  contents: string,
  config: { maxOutputTokens: number; temperature?: number; responseMimeType?: string; responseJsonSchema?: unknown },
) => {
  const models = await getAvailableGeminiModels(client);
  for (const model of models) {
    try {
      const response = await client.models.generateContent({ model, contents, config });
      if (response.text?.trim()) return response;
    } catch (error) {
      const failure = classifyGeminiError(error);
      if (failure.category !== 'model_unavailable') throw failure;
    }
  }
  throw new GeminiProviderError('model_unavailable', 404);
};

export const checkGeminiConnection = async () => {
  const apiKey = config.geminiApiKey.trim();
  if (!apiKey) {
    return {
      configured: false,
      connected: false,
      provider: 'gemini' as const,
      category: 'missing_api_key' as const,
      statusCode: 503,
    };
  }

  try {
    const client = createGeminiClient(apiKey);
    await generateGeminiContent(client, 'Reply with exactly: OK', {
      maxOutputTokens: 8,
      temperature: 0,
    });
    return {
      configured: true,
      connected: true,
      provider: 'gemini' as const,
    };
  } catch (error) {
    const failure = classifyGeminiError(error);
    return {
      configured: true,
      connected: false,
      provider: 'gemini' as const,
      category: failure.category,
      statusCode: failure.providerStatus ?? 502,
    };
  }
};

export const retrieveRelevantPolicies = (claim: ExpenseClaim, policies: PolicySection[]) => {
  const query = `${claim.category} ${claim.description} ${claim.claimant}`.toLowerCase();
  return policies.filter((policy) => {
    const haystack = `${policy.title} ${policy.summary} ${policy.policyText} ${policy.categories.join(' ')}`.toLowerCase();
    return haystack.includes(query) || policy.categories.includes(claim.category) || normalizeText(policy.policyText).includes(normalizeText(claim.description));
  });
};

const buildMockReview = (claim: ExpenseClaim, policies: PolicySection[]): AIReview => {
  const relevant = retrieveRelevantPolicies(claim, policies);
  const category = claim.category;
  const classificationUncertain = claim.description.toLowerCase().includes('misc') || claim.description.toLowerCase().includes('various');
  const reviewStatus = classificationUncertain ? 'clarification_required' : 'potentially_compliant';

  return {
    suggestedCategory: category,
    confidence: classificationUncertain ? 0.61 : 0.84,
    classificationUncertain,
    reviewStatus,
    summary: classificationUncertain
      ? 'The description is somewhat ambiguous and the claim needs a quick reviewer check.'
      : 'The claim appears aligned with the retrieved policy evidence and is likely compliant.',
    findings: relevant.length > 0
      ? relevant.map((policy, index) => ({
          code: 'policy_check',
          severity: index === 0 ? 'info' : 'warning',
          message: `The policy section ${policy.id} supports this category and expense treatment.`,
          field: 'category',
          policySectionIds: [policy.id],
          evidence: policy.policyText,
          requiresClarification: false,
        }))
      : [{
          code: 'missing_policy',
          severity: 'warning',
          message: 'No matching policy section was retrieved for the claim.',
          field: 'category',
          policySectionIds: [],
          evidence: 'No policy evidence was retrieved from the database.',
          requiresClarification: true,
        }],
    missingInformation: claim.receiptAvailable ? [] : ['Receipt not attached for category requiring documentation.'],
    clarificationQuestions: classificationUncertain ? ['Please clarify the purpose of this expense to confirm the correct category.'] : [],
    limitations: ['This is a deterministic mock review for demo mode.'],
    policySectionIds: relevant.map((policy) => policy.id),
    generatedAt: new Date().toISOString(),
    source: 'mock',
  };
};

const validateCitations = (review: AIReview, policies: PolicySection[]) => {
  const validIds = new Set(policies.map((policy) => policy.id));
  const allValid = review.policySectionIds.length > 0
    && review.policySectionIds.every((id) => validIds.has(id))
    && review.findings.every((finding) => finding.policySectionIds.every((id) => validIds.has(id)));
  return allValid;
};

const unavailableReview = (claim: ExpenseClaim, reason: string): AIReview => ({
  suggestedCategory: claim.category,
  confidence: 0,
  classificationUncertain: true,
  reviewStatus: 'needs_attention',
  summary: reason,
  findings: [{
    code: 'ai_unavailable',
    severity: 'warning',
    message: 'The AI provider could not produce a valid review; deterministic validation results remain available.',
    field: 'aiReview',
    policySectionIds: [],
    evidence: 'AI review was unavailable or invalid.',
    requiresClarification: true,
  }],
  missingInformation: ['AI review unavailable.'],
  clarificationQuestions: ['Please review the claim manually.'],
  limitations: ['AI service unavailable or returned an invalid response.'],
  policySectionIds: [],
  generatedAt: new Date().toISOString(),
  source: 'unavailable',
});

export const performAIReview = async (claim: ExpenseClaim, policies: PolicySection[]): Promise<AIReview> => {
  const apiKey = config.geminiApiKey.trim();

  if (config.demoMode) {
    const review = buildMockReview(claim, policies);
    if (!validateCitations(review, policies)) {
      return {
        ...review,
        reviewStatus: 'needs_attention',
        summary: 'The generated policy citations could not be validated against the database. This review requires manual correction.',
        limitations: ['AI citations were invalid and flagged for human review.'],
        source: 'unavailable',
      };
    }
    return review;
  }

  if (!apiKey) {
    return unavailableReview(claim, 'AI provider unavailable because GEMINI_API_KEY is not configured.');
  }

  try {
    const relevantPolicies = retrieveRelevantPolicies(claim, policies);
    if (relevantPolicies.length === 0) {
      return unavailableReview(claim, 'No matching policy sections were available to support an AI review.');
    }
    const prompt = JSON.stringify({
      claim: { ...claim },
      policyContext: relevantPolicies.map((policy) => ({
        id: policy.id,
        title: policy.title,
        text: policy.policyText,
      })),
      instructions: 'Return only a JSON object with suggestedCategory, confidence, classificationUncertain, reviewStatus, summary, findings, missingInformation, clarificationQuestions, limitations, and policySectionIds. Use only policy IDs present in policyContext. Do not invent policy requirements.',
    });
    const client = createGeminiClient(apiKey);
    const response = await generateGeminiContent(client, prompt, {
      responseMimeType: 'application/json',
      responseJsonSchema: geminiReviewResponseSchema,
      maxOutputTokens: 2048,
    });
    const content = response.text;
    if (typeof content !== 'string' || !content.trim()) {
      throw new GeminiProviderError('invalid_response');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new GeminiProviderError('invalid_response');
    }
    const validated = AIReviewSchema.safeParse({
      ...(typeof parsed === 'object' && parsed !== null ? parsed : {}),
      generatedAt: new Date().toISOString(),
      source: 'gemini',
    });
    if (!validated.success) {
      return unavailableReview(claim, 'Gemini returned a response that did not match the required review format.');
    }
    const review = validated.data;

    if (!validateCitations(review, relevantPolicies)) {
      return {
        ...review,
        reviewStatus: 'needs_attention',
        summary: 'The AI supplied invalid policy citations and therefore requires reviewer attention.',
        limitations: [...review.limitations, 'AI citations did not validate against the retrieved policy sections.'],
        source: 'unavailable',
      };
    }

    if (review.confidence < confidenceThreshold || review.classificationUncertain) {
      review.reviewStatus = 'clarification_required';
    }
    return review;
  } catch (error) {
    return unavailableReview(claim, geminiFailureMessage(classifyGeminiError(error)));
  }
};
