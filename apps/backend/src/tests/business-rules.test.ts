import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../app.js';
import { memoryStore } from '../store.js';
import { seedDatabase } from '../seed.js';
import { checkGeminiConnection, performAIReview } from '../services/ai.js';
import { detectDuplicateClaims, runDeterministicValidation, validateClaimInput } from '../services/validation.js';
import { config } from '../config.js';

const geminiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  generateContent: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      list: geminiMocks.list,
      generateContent: geminiMocks.generateContent,
    },
  })),
}));

const originalConfig = {
  geminiApiKey: config.geminiApiKey,
  demoMode: config.demoMode,
  mongoConfigured: config.mongoConfigured,
};

const availableGeminiModels = [{
  name: 'models/gemini-2.5-flash',
  supportedActions: ['generateContent'],
}];

const mockGeminiResponse = (content: string) => {
  geminiMocks.list.mockResolvedValue(availableGeminiModels);
  geminiMocks.generateContent.mockResolvedValue({ text: content });
};

beforeEach(async () => {
  config.geminiApiKey = '';
  config.demoMode = true;
  config.mongoConfigured = false;
  geminiMocks.list.mockReset();
  geminiMocks.generateContent.mockReset();
  memoryStore.reset();
  await seedDatabase();
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  config.geminiApiKey = originalConfig.geminiApiKey;
  config.demoMode = originalConfig.demoMode;
  config.mongoConfigured = originalConfig.mongoConfigured;
});

describe('Expense claim policy review backend', () => {
  it('validates required claim fields', () => {
    const findings = validateClaimInput({ claimant: '', category: 'Travel', amount: 0, currency: 'USD', description: 'test' });
    expect(findings.some((f) => f.code === 'required_claimant')).toBe(true);
    expect(findings.some((f) => f.code === 'invalid_amount')).toBe(true);
  });

  it('rejects invalid dates and amounts', async () => {
    const response = await request(app).post('/api/claims').send({
      claimant: 'Test User',
      expenseDate: '2027-99-99',
      category: 'Travel',
      amount: -5,
      currency: 'USD',
      description: 'Trip to a client meeting',
      receiptAvailable: true,
    });

    expect(response.status).toBe(422);
  });

  it('rejects impossible calendar dates even when they match the expected date format', async () => {
    const response = await request(app).post('/api/claims').send({
      claimant: 'Test User',
      expenseDate: '2026-02-30',
      category: 'Travel',
      amount: 50,
      currency: 'USD',
      description: 'Client trip',
      receiptAvailable: true,
    });
    expect(response.status).toBe(400);
    expect(response.body.errors.some((finding: { code: string }) => finding.code === 'invalid_date')).toBe(true);
  });

  it('submits valid claims and flags exact duplicates deterministically', async () => {
    const original = memoryStore.getState().claims[0];
    const response = await request(app).post('/api/claims').send({
      claimant: original.claimant,
      expenseDate: original.expenseDate,
      category: original.category,
      amount: original.amount,
      currency: original.currency,
      description: original.description,
      receiptAvailable: original.receiptAvailable,
    });

    expect(response.status).toBe(201);
    expect(response.body.data.duplicateCheck.exactDuplicate).toBe(true);
    expect(response.body.data.deterministicFindings.some((finding: { code: string }) => finding.code === 'duplicate_exact')).toBe(true);
    expect(response.body.data.reviewHistory.some((entry: { action: string }) => entry.action === 'claim_submitted')).toBe(true);
  });

  it('does not allow claim edits to inject or mislabel AI output', async () => {
    const originalReview = memoryStore.getState().claims[3].aiReview;
    const response = await request(app)
      .patch('/api/claims/CLM-004')
      .set('x-user-role', 'employee')
      .send({ aiReview: { source: 'openai', summary: 'Forged live result.' } });
    expect(response.status).toBe(422);
    expect(memoryStore.getState().claims[3].aiReview).toEqual(originalReview);
  });

  it('detects exact and possible duplicates using normalized claim values', () => {
    const claim = memoryStore.getState().claims[0];
    const exact = detectDuplicateClaims({ ...claim, id: 'CLM-NEW' }, [claim]);
    const possible = detectDuplicateClaims({
      ...claim,
      id: 'CLM-POSSIBLE',
      amount: claim.amount * 1.1,
      description: `${claim.description} additional details`,
    }, [claim]);
    expect(exact).toEqual({ exactDuplicate: true, possibleDuplicate: true, duplicateIds: [claim.id] });
    expect(possible.exactDuplicate).toBe(false);
    expect(possible.possibleDuplicate).toBe(true);
  });

  it('flags missing receipt and category limits', () => {
    const claim: any = {
      id: 'CLM-SAMPLE',
      claimant: 'Bob',
      expenseDate: '2026-10-06',
      category: 'Meals',
      amount: 300,
      currency: 'USD',
      description: 'Team lunch event',
      receiptAvailable: false,
      status: 'submitted',
      finalDecision: 'pending',
      duplicateCheck: { exactDuplicate: false, possibleDuplicate: false, duplicateIds: [] },
      reviewHistory: [],
    };
    const findings = runDeterministicValidation(claim, memoryStore.getState().policies);
    expect(findings.some((f) => f.code === 'missing_receipt')).toBe(true);
    expect(findings.some((f) => f.code === 'category_limit_exceeded')).toBe(true);
  });

  it('returns a valid AI review shape', async () => {
    const claim = memoryStore.getState().claims[3];
    const review = await performAIReview(claim, memoryStore.getState().policies);
    expect(review.suggestedCategory).toBeDefined();
    expect(review.source).toBe('mock');
    expect(review.limitations.some((limitation) => limitation.toLowerCase().includes('mock'))).toBe(true);
    expect(review.confidence).toBeGreaterThanOrEqual(0);
    expect(review.findings).toBeInstanceOf(Array);
    expect(review.policySectionIds.every((id) => memoryStore.getState().policies.some((policy) => policy.id === id))).toBe(true);
  });

  it('marks invalid AI citations for reviewer attention', async () => {
    config.geminiApiKey = 'test-only-key';
    config.demoMode = false;
    const claim = memoryStore.getState().claims[3];
    mockGeminiResponse(JSON.stringify({
      suggestedCategory: claim.category,
      confidence: 0.9,
      classificationUncertain: false,
      reviewStatus: 'potentially_compliant',
      summary: 'Looks fine',
      findings: [{
        code: 'policy_check',
        severity: 'info',
        message: 'Fake citation.',
        policySectionIds: ['FAKE-000'],
        evidence: 'Unverified evidence.',
        requiresClarification: false,
      }],
      missingInformation: [],
      clarificationQuestions: [],
      limitations: [],
      policySectionIds: ['FAKE-000'],
    }));

    const review = await performAIReview(claim, memoryStore.getState().policies);
    expect(review.source).toBe('unavailable');
    expect(review.reviewStatus).toBe('needs_attention');
  });

  it('does not fabricate a mock review when live mode is explicitly requested without a key', async () => {
    config.demoMode = false;
    const review = await performAIReview(memoryStore.getState().claims[3], memoryStore.getState().policies);
    expect(review.source).toBe('unavailable');
    expect(geminiMocks.list).not.toHaveBeenCalled();
    expect(geminiMocks.generateContent).not.toHaveBeenCalled();
  });

  it('does not report successful persistence when configured MongoDB is disconnected', async () => {
    config.mongoConfigured = true;
    const claim = { ...memoryStore.getState().claims[0], id: 'CLM-DB-OFFLINE' };
    const existingCount = memoryStore.getState().claims.length;
    await expect(memoryStore.commitClaim(claim)).rejects.toThrow('MongoDB is configured but disconnected');
    expect(memoryStore.getState().claims).toHaveLength(existingCount);
  });

  it('validates live Gemini output and selects an available text-generation model', async () => {
    config.geminiApiKey = 'test-only-key';
    config.demoMode = false;
    const claim = memoryStore.getState().claims[3];
    const policy = memoryStore.getState().policies.find((item) => item.categories.includes(claim.category));
    expect(policy).toBeDefined();
    mockGeminiResponse(JSON.stringify({
      suggestedCategory: claim.category,
      confidence: 0.9,
      classificationUncertain: false,
      reviewStatus: 'potentially_compliant',
      summary: 'Reviewed against policy.',
      findings: [{
        code: 'policy_check',
        severity: 'info',
        message: 'The policy supports the claim.',
        policySectionIds: [policy!.id],
        evidence: policy!.policyText,
        requiresClarification: false,
      }],
      missingInformation: [],
      clarificationQuestions: [],
      limitations: [],
      policySectionIds: [policy!.id],
    }));

    const review = await performAIReview(claim, memoryStore.getState().policies);
    expect(geminiMocks.list).toHaveBeenCalled();
    expect(geminiMocks.generateContent).toHaveBeenCalled();
    expect(review.source).toBe('gemini');
    expect(review.policySectionIds).toEqual([policy!.id]);
    expect(geminiMocks.generateContent).toHaveBeenCalledWith(expect.objectContaining({
      model: 'models/gemini-2.5-flash',
      config: expect.objectContaining({
        responseMimeType: 'application/json',
        responseJsonSchema: expect.objectContaining({ type: 'OBJECT' }),
      }),
    }));
    expect(review.summary).not.toContain('test-only-key');
  });

  it('returns unavailable for malformed Gemini response JSON', async () => {
    config.geminiApiKey = 'test-only-key';
    config.demoMode = false;
    mockGeminiResponse('{not-json');
    const review = await performAIReview(memoryStore.getState().claims[3], memoryStore.getState().policies);
    expect(review.source).toBe('unavailable');
    expect(review.reviewStatus).toBe('needs_attention');
  });

  it('handles invalid Gemini credentials gracefully without returning the key', async () => {
    config.geminiApiKey = 'test-only-key';
    config.demoMode = false;
    geminiMocks.list.mockRejectedValueOnce({ status: 401, message: 'secret must not be returned' });
    const review = await performAIReview(memoryStore.getState().claims[3], memoryStore.getState().policies);
    expect(review.source).toBe('unavailable');
    expect(review.summary).toContain('valid Gemini API key');
    expect(review.summary).not.toContain('test-only-key');
    expect(review.summary).not.toContain('secret must not be returned');
  });

  it('explains when Gemini quota is exhausted without returning the key', async () => {
    config.geminiApiKey = 'test-only-key';
    config.demoMode = false;
    geminiMocks.list.mockRejectedValueOnce({ status: 429, message: 'quota details must not be returned' });
    const review = await performAIReview(memoryStore.getState().claims[3], memoryStore.getState().policies);
    expect(review.source).toBe('unavailable');
    expect(review.summary).toContain('Gemini quota or rate limit');
    expect(review.summary).not.toContain('test-only-key');
  });

  it('does not approve or reject a claim when Gemini review fails', async () => {
    config.geminiApiKey = 'test-only-key';
    config.demoMode = false;
    geminiMocks.list.mockRejectedValueOnce({ status: 429 });
    const claim = memoryStore.getState().claims[3];
    claim.status = 'pending_review';
    claim.finalDecision = 'pending';
    memoryStore.saveClaim(claim);

    const response = await request(app)
      .post(`/api/claims/${claim.id}/review`)
      .set('x-user-role', 'reviewer')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.data.aiReview.source).toBe('unavailable');
    expect(response.body.data.finalDecision).toBe('pending');
    expect(response.body.data.status).toBe('needs_attention');
  });

  it('reports Gemini missing-key status without making an API call', async () => {
    const response = await request(app).get('/api/health/ai');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      configured: false,
      connected: false,
      provider: 'gemini',
      category: 'missing_api_key',
      statusCode: 503,
    });
    expect(geminiMocks.list).not.toHaveBeenCalled();
  });

  it('returns a sanitized Gemini credential failure from the diagnostic endpoint', async () => {
    config.geminiApiKey = 'test-only-key';
    geminiMocks.list.mockRejectedValueOnce({ status: 401, message: 'provider detail must not be returned' });

    const response = await request(app).get('/api/health/ai');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      configured: true,
      connected: false,
      provider: 'gemini',
      category: 'invalid_api_key',
      statusCode: 401,
    });
    expect(JSON.stringify(response.body)).not.toContain('test-only-key');
    expect(JSON.stringify(response.body)).not.toContain('provider detail');
  });

  it('runs a synthetic Gemini connectivity request and returns sanitized status', async () => {
    config.geminiApiKey = 'test-only-key';
    geminiMocks.list.mockResolvedValue(availableGeminiModels);
    geminiMocks.generateContent.mockResolvedValue({ text: 'OK' });

    const response = await request(app).get('/api/health/ai');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ configured: true, connected: true, provider: 'gemini' });
    expect(geminiMocks.generateContent).toHaveBeenCalledWith(expect.objectContaining({
      model: 'models/gemini-2.5-flash',
      contents: 'Reply with exactly: OK',
    }));
    expect(JSON.stringify(response.body)).not.toContain('test-only-key');
  });

  it('reports when the configured API key has no supported text-generation model', async () => {
    config.geminiApiKey = 'test-only-key';
    geminiMocks.list.mockResolvedValue([{ name: 'models/embedding-001', supportedActions: ['embedContent'] }]);

    const result = await checkGeminiConnection();
    expect(result).toMatchObject({
      configured: true,
      connected: false,
      provider: 'gemini',
      category: 'model_unavailable',
      statusCode: 404,
    });
    expect(geminiMocks.generateContent).not.toHaveBeenCalled();
  });

  it('requires rejection and approval decisions to follow valid transitions', async () => {
    const claim = memoryStore.getState().claims[0];
    claim.status = 'approved';
    claim.finalDecision = 'approved';
    memoryStore.saveClaim(claim);
    const response = await request(app).post(`/api/claims/${claim.id}/approve`).set('x-user-role', 'reviewer').send({ reviewer: 'reviewer@demo.local', reason: 'Approved' });
    expect(response.status).toBe(409);
    const clarificationClaim = memoryStore.getState().claims[2];
    clarificationClaim.status = 'submitted';
    memoryStore.saveClaim(clarificationClaim);
    const response2 = await request(app).post(`/api/claims/${clarificationClaim.id}/request-clarification`).set('x-user-role', 'reviewer').send({ reviewer: 'reviewer@demo.local', reason: 'Need details' });
    expect(response2.status).toBe(200);
  });

  it('enforces reviewer roles and records classification overrides in history and audit', async () => {
    const denied = await request(app)
      .post('/api/claims/CLM-003/override-classification')
      .set('x-user-role', 'employee')
      .send({ reason: 'Wrong category.', newCategory: 'Office' });
    expect(denied.status).toBe(403);

    const response = await request(app)
      .post('/api/claims/CLM-003/override-classification')
      .set('x-user-role', 'reviewer')
      .send({ reviewer: 'reviewer@demo.local', reason: 'Corrected after review.', newCategory: 'Office' });
    expect(response.status).toBe(200);
    expect(response.body.data.category).toBe('Office');
    expect(response.body.data.reviewHistory.some((entry: { action: string }) => entry.action === 'classification_overridden')).toBe(true);
    expect(memoryStore.getState().auditEvents.some((event) => event.action === 'classification_overridden')).toBe(true);
  });

  it('allows reviewer decisions and returns their audit history', async () => {
    const approved = await request(app)
      .post('/api/claims/CLM-004/approve')
      .set('x-user-role', 'reviewer')
      .send({ reason: 'Policy requirements met.' });
    expect(approved.status).toBe(200);
    expect(approved.body.data.finalDecision).toBe('approved');

    const rejected = await request(app)
      .post('/api/claims/CLM-006/reject')
      .set('x-user-role', 'reviewer')
      .send({ reason: 'Required prior approval is absent.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.finalDecision).toBe('rejected');

    const history = await request(app).get('/api/claims/CLM-004/history');
    expect(history.status).toBe(200);
    expect(history.body.data.some((entry: { action: string }) => entry.action === 'approved')).toBe(true);
  });

  it('prevents employees from creating policy records', async () => {
    const response = await request(app)
      .post('/api/policies')
      .set('x-user-role', 'employee')
      .send({
        title: 'Policy Test',
        summary: 'Summary',
        policyText: 'A sufficiently long policy description for this endpoint test.',
        categories: ['Travel'],
        effectiveDate: '2026-01-01',
      });
    expect(response.status).toBe(403);
  });

  it('creates audit events for claim actions', async () => {
    const response = await request(app).post('/api/claims/CLM-003/request-clarification').set('x-user-role', 'reviewer').send({ reviewer: 'reviewer@demo.local', reason: 'Missing receipt.' });
    expect(response.status).toBe(200);
    expect(memoryStore.getState().auditEvents.length).toBeGreaterThan(0);
  });
});
