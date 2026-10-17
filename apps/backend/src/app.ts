import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { config } from './config.js';
import { isDatabaseConnected } from './models.js';
import { memoryStore } from './store.js';
import { CategorySchema, CurrencySchema, ExpenseClaim, PolicySection, ReviewActionSchema } from './types.js';
import { computeDashboardMetrics, detectDuplicateClaims, runDeterministicValidation, validateClaimInput } from './services/validation.js';
import { checkGeminiConnection, performAIReview } from './services/ai.js';

const app = express();
app.set('json replacer', (key: string, value: unknown) => (
  (key === 'source' || key === 'provider')
    && typeof value === 'string'
    && ['gemini', 'openai'].includes(value.toLowerCase())
    ? 'automated'
    : value
));
app.use(cors({
  origin: (origin, callback) => callback(
    null,
    origin === undefined || config.frontendOrigins.includes(origin),
  ),
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
app.use(rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));

const ensureRole = (role: 'admin' | 'reviewer' | 'employee') => (req: Request, res: Response, next: NextFunction) => {
  const userRole = String(req.headers['x-user-role'] || 'reviewer');
  if (userRole === role || userRole === 'admin') return next();
  return res.status(403).json({ message: 'Forbidden: role is not authorized for this action.' });
};

const getClaimById = (id: string) => memoryStore.getState().claims.find((c) => c.id === id);
const asyncHandler = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
const appendHistory = (claim: ExpenseClaim, actor: string, action: string, reason?: string, before?: unknown, after?: unknown) => {
  const entry = {
    timestamp: new Date().toISOString(),
    actor,
    action,
    reason,
    before,
    after,
  };
  claim.reviewHistory = [...(claim.reviewHistory || []), entry];
};

const createAuditEvent = (actor: string, action: string, claimId?: string, reason?: string, before?: unknown, after?: unknown) => {
  return { id: randomUUID(), timestamp: new Date().toISOString(), actor, action, claimId, reason, before, after };
};

app.get('/api/health', (_req, res) => res.json({
  ok: !config.mongoConfigured || isDatabaseConnected(),
  mode: config.demoMode ? 'demo' : config.geminiApiKey ? 'live' : 'unavailable',
  storage: isDatabaseConnected() ? 'mongodb' : 'memory',
}));

app.get('/api/health/ai', asyncHandler(async (_req, res) => {
  const result = await checkGeminiConnection();
  res.status(result.connected ? 200 : result.statusCode || 503).json(result);
}));

app.get('/api/policies', (_req, res) => {
  res.json({ data: memoryStore.getState().policies, count: memoryStore.getState().policies.length });
});

app.post('/api/policies', ensureRole('reviewer'), asyncHandler(async (req, res) => {
  const body = z.object({
    title: z.string().min(2),
    summary: z.string().min(2),
    policyText: z.string().min(20),
    categories: z.array(CategorySchema).min(1),
    categoryLimits: z.array(z.object({ category: CategorySchema, maxAmount: z.number().nonnegative(), currency: CurrencySchema })).optional(),
    receiptRequired: z.boolean().optional(),
    effectiveDate: z.string(),
    status: z.enum(['active', 'inactive']).optional(),
  }).parse(req.body);

  const policy: PolicySection = {
    id: body.title.toUpperCase().replace(/\s+/g, '-').slice(0, 10) + '-' + String(Date.now()).slice(-3),
    title: body.title,
    summary: body.summary,
    policyText: body.policyText,
    categories: body.categories,
    categoryLimits: body.categoryLimits,
    receiptRequired: Boolean(body.receiptRequired),
    effectiveDate: body.effectiveDate,
    status: body.status || 'active',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await memoryStore.commitPolicy(policy);
  res.status(201).json({ data: policy });
}));

app.patch('/api/policies/:id', ensureRole('reviewer'), asyncHandler(async (req, res) => {
  const policy = memoryStore.getState().policies.find((item) => item.id === req.params.id);
  if (!policy) return res.status(404).json({ message: 'Policy not found.' });
  const parsed = z.object({
    title: z.string().min(2).optional(),
    summary: z.string().min(2).optional(),
    policyText: z.string().min(20).optional(),
    categories: z.array(CategorySchema).min(1).optional(),
    categoryLimits: z.array(z.object({ category: CategorySchema, maxAmount: z.number().nonnegative(), currency: CurrencySchema })).optional(),
    receiptRequired: z.boolean().optional(),
    effectiveDate: z.string().min(1).optional(),
    status: z.enum(['active', 'inactive']).optional(),
  }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ message: 'Invalid request payload.', issues: parsed.error.issues });
  if (Object.keys(parsed.data).length === 0) return res.status(422).json({ message: 'At least one policy field is required.' });
  const updated: PolicySection = { ...policy, ...parsed.data, id: policy.id, updatedAt: new Date().toISOString(), version: (policy.version || 1) + 1 };
  await memoryStore.commitPolicy(updated);
  res.json({ data: updated });
}));

app.post('/api/policies/:id/deactivate', ensureRole('admin'), asyncHandler(async (req, res) => {
  const policy = memoryStore.getState().policies.find((item) => item.id === req.params.id);
  if (!policy) return res.status(404).json({ message: 'Policy not found.' });
  const updated = { ...policy, status: 'inactive', updatedAt: new Date().toISOString() } as PolicySection;
  await memoryStore.commitPolicy(updated);
  res.json({ data: updated });
}));

app.get('/api/claims', (_req, res) => {
  res.json({ data: memoryStore.getState().claims, count: memoryStore.getState().claims.length });
});

app.post('/api/claims', asyncHandler(async (req, res) => {
  const parsed = z.object({
    claimant: z.string().min(2),
    expenseDate: z.string().min(1),
    category: CategorySchema,
    amount: z.number().finite().positive(),
    currency: CurrencySchema,
    description: z.string().min(3),
    receiptAvailable: z.boolean().optional(),
    submittedBy: z.string().optional(),
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(422).json({ message: 'Invalid request payload.', issues: parsed.error.issues });
  }

  const body = parsed.data;
  const errors = validateClaimInput(body);
  if (errors.length > 0) {
    return res.status(400).json({ message: 'Claim validation failed.', errors });
  }

  if (memoryStore.getState().claims.length >= 1000) {
    return res.status(400).json({ message: 'Maximum claim count reached for this demo environment.' });
  }

  const claim: ExpenseClaim = {
    id: `CLM-${String(Date.now()).slice(-6)}`,
    claimant: body.claimant,
    expenseDate: body.expenseDate,
    category: body.category,
    amount: Number(body.amount),
    currency: body.currency,
    description: body.description,
    receiptAvailable: Boolean(body.receiptAvailable),
    status: 'submitted',
    finalDecision: 'pending',
    deterministicFindings: [],
    duplicateCheck: { exactDuplicate: false, possibleDuplicate: false, duplicateIds: [] },
    reviewHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    submittedBy: body.submittedBy || 'employee',
  };

  const sameClaims = memoryStore.getState().claims;
  claim.duplicateCheck = detectDuplicateClaims(claim, sameClaims);
  claim.deterministicFindings = runDeterministicValidation(claim, memoryStore.getState().policies);
  claim.aiReview = await performAIReview(claim, memoryStore.getState().policies);
  if (claim.aiReview.reviewStatus === 'clarification_required' || claim.aiReview.classificationUncertain || claim.deterministicFindings.some((finding) => finding.requiresClarification)) {
    claim.status = 'clarification_required';
  } else if (claim.deterministicFindings.some((f) => f.severity === 'error') || claim.duplicateCheck.exactDuplicate) {
    claim.status = 'needs_attention';
  } else {
    claim.status = 'pending_review';
  }

  appendHistory(claim, 'system', 'claim_submitted', 'Initial submission received.');
  const auditEvent = createAuditEvent('system', 'claim_submitted', claim.id, 'Initial submission received.', null, claim.status);
  await memoryStore.commitClaim(claim);
  await memoryStore.commitAudit(auditEvent);
  res.status(201).json({ data: claim });
}));

app.get('/api/claims/:id', (req, res) => {
  const claim = getClaimById(String(req.params.id));
  if (!claim) return res.status(404).json({ message: 'Claim not found.' });
  res.json({ data: claim });
});

app.patch('/api/claims/:id', ensureRole('employee'), asyncHandler(async (req, res) => {
  const existingClaim = getClaimById(String(req.params.id));
  if (!existingClaim) return res.status(404).json({ message: 'Claim not found.' });
  if (existingClaim.status === 'approved' || existingClaim.status === 'rejected') {
    return res.status(409).json({ message: 'A finalized claim cannot be changed.' });
  }
  const parsed = z.object({
    claimant: z.string().min(2).optional(),
    expenseDate: z.string().min(1).optional(),
    category: CategorySchema.optional(),
    amount: z.number().finite().positive().optional(),
    currency: CurrencySchema.optional(),
    description: z.string().min(3).optional(),
    receiptAvailable: z.boolean().optional(),
  }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ message: 'Invalid request payload.', issues: parsed.error.issues });
  if (Object.keys(parsed.data).length === 0) return res.status(422).json({ message: 'At least one claim field is required.' });
  const claim = structuredClone(existingClaim);
  const updatedClaim = { ...claim, ...parsed.data };
  const validationErrors = validateClaimInput(updatedClaim);
  if (validationErrors.length > 0) return res.status(400).json({ message: 'Claim validation failed.', errors: validationErrors });

  const before = { ...claim };
  Object.assign(claim, parsed.data, { updatedAt: new Date().toISOString(), aiReview: undefined });
  claim.duplicateCheck = detectDuplicateClaims(claim, memoryStore.getState().claims);
  claim.deterministicFindings = runDeterministicValidation(claim, memoryStore.getState().policies);
  if (claim.deterministicFindings.some((finding) => finding.severity === 'error') || claim.duplicateCheck.exactDuplicate) {
    claim.status = 'needs_attention';
  } else if (claim.deterministicFindings.some((finding) => finding.requiresClarification)) {
    claim.status = 'clarification_required';
  } else {
    claim.status = 'pending_review';
  }
  appendHistory(claim, 'employee', 'claim_updated', 'Claim updated by submitter.', before, { ...claim });
  const auditEvent = createAuditEvent('employee', 'claim_updated', claim.id, 'Claim update saved', before, { ...claim });
  await memoryStore.commitClaim(claim);
  await memoryStore.commitAudit(auditEvent);
  res.json({ data: claim });
}));

app.get('/api/claims/:id/history', (req, res) => {
  const claim = getClaimById(String(req.params.id));
  if (!claim) return res.status(404).json({ message: 'Claim not found.' });
  res.json({ data: claim.reviewHistory || [] });
});

const getReviewerName = (req: Request) => {
  const raw = req.headers['x-user-role'];
  const value = Array.isArray(raw) ? raw[0] || 'reviewer@demo.local' : raw || 'reviewer@demo.local';
  return String(value);
};

app.post('/api/claims/:id/review', ensureRole('reviewer'), asyncHandler(async (req, res) => {
  const existingClaim = getClaimById(String(req.params.id));
  if (!existingClaim) return res.status(404).json({ message: 'Claim not found.' });
  if (existingClaim.status === 'approved' || existingClaim.status === 'rejected') {
    return res.status(409).json({ message: 'A finalized claim cannot be reviewed again.' });
  }
  const claim = structuredClone(existingClaim);
  const before = structuredClone(existingClaim);
  claim.aiReview = await performAIReview(claim, memoryStore.getState().policies);
  claim.deterministicFindings = runDeterministicValidation(claim, memoryStore.getState().policies);
  claim.status = claim.aiReview.reviewStatus === 'needs_attention' ? 'needs_attention' : claim.status;
  appendHistory(claim, 'reviewer', 'ai_reviewed', 'AI policy review completed.', before, { ...claim });
  const auditEvent = createAuditEvent('reviewer', 'ai_reviewed', claim.id, 'AI review completed', before, { ...claim });
  await memoryStore.commitClaim(claim);
  await memoryStore.commitAudit(auditEvent);
  res.json({ data: claim });
}));

app.post('/api/claims/:id/approve', ensureRole('reviewer'), asyncHandler(async (req, res) => {
  const existingClaim = getClaimById(String(req.params.id));
  if (!existingClaim) return res.status(404).json({ message: 'Claim not found.' });
  if (existingClaim.status === 'approved' || existingClaim.status === 'rejected') {
    return res.status(409).json({ message: 'This claim has already reached a terminal state.' });
  }
  const reviewPayload = {
    ...(req.body as Record<string, unknown>),
    reviewer: getReviewerName(req),
    reason: String((req.body as Record<string, unknown>)?.reason ?? 'Approved after review.'),
  };
  const body = ReviewActionSchema.parse(reviewPayload);
  const claim = structuredClone(existingClaim);
  const before = structuredClone(existingClaim);
  claim.finalDecision = 'approved';
  claim.status = 'approved';
  claim.reviewHistory = [...(claim.reviewHistory || []), { timestamp: new Date().toISOString(), actor: body.reviewer, action: 'approved', reason: body.reason, before, after: { ...claim } }];
  const auditEvent = createAuditEvent(body.reviewer, 'approved', claim.id, body.reason, before, { ...claim });
  await memoryStore.commitClaim(claim);
  await memoryStore.commitAudit(auditEvent);
  res.json({ data: claim });
}));

app.post('/api/claims/:id/reject', ensureRole('reviewer'), asyncHandler(async (req, res) => {
  const existingClaim = getClaimById(String(req.params.id));
  if (!existingClaim) return res.status(404).json({ message: 'Claim not found.' });
  if (existingClaim.status === 'approved' || existingClaim.status === 'rejected') {
    return res.status(409).json({ message: 'This claim is already in a terminal state.' });
  }
  const reviewPayload = {
    ...(req.body as Record<string, unknown>),
    reviewer: getReviewerName(req),
    reason: String((req.body as Record<string, unknown>)?.reason ?? 'Rejected after review.'),
  };
  const body = ReviewActionSchema.parse(reviewPayload);
  const claim = structuredClone(existingClaim);
  const before = structuredClone(existingClaim);
  claim.finalDecision = 'rejected';
  claim.status = 'rejected';
  claim.reviewHistory = [...(claim.reviewHistory || []), { timestamp: new Date().toISOString(), actor: body.reviewer, action: 'rejected', reason: body.reason, before, after: { ...claim } }];
  const auditEvent = createAuditEvent(body.reviewer, 'rejected', claim.id, body.reason, before, { ...claim });
  await memoryStore.commitClaim(claim);
  await memoryStore.commitAudit(auditEvent);
  res.json({ data: claim });
}));

app.post('/api/claims/:id/request-clarification', ensureRole('reviewer'), asyncHandler(async (req, res) => {
  const existingClaim = getClaimById(String(req.params.id));
  if (!existingClaim) return res.status(404).json({ message: 'Claim not found.' });
  if (existingClaim.status === 'approved' || existingClaim.status === 'rejected') {
    return res.status(409).json({ message: 'A finalized claim cannot be sent for clarification.' });
  }
  const reviewPayload = {
    ...(req.body as Record<string, unknown>),
    reviewer: getReviewerName(req),
    reason: String((req.body as Record<string, unknown>)?.reason ?? 'Clarification requested.'),
  };
  const body = ReviewActionSchema.parse(reviewPayload);
  const claim = structuredClone(existingClaim);
  const before = structuredClone(existingClaim);
  claim.status = 'clarification_required';
  claim.reviewHistory = [...(claim.reviewHistory || []), { timestamp: new Date().toISOString(), actor: body.reviewer, action: 'clarification_requested', reason: body.reason, before, after: { ...claim } }];
  const auditEvent = createAuditEvent(body.reviewer, 'clarification_requested', claim.id, body.reason, before, { ...claim });
  await memoryStore.commitClaim(claim);
  await memoryStore.commitAudit(auditEvent);
  res.json({ data: claim });
}));

app.post('/api/claims/:id/override-classification', ensureRole('reviewer'), asyncHandler(async (req, res) => {
  const existingClaim = getClaimById(String(req.params.id));
  if (!existingClaim) return res.status(404).json({ message: 'Claim not found.' });
  if (existingClaim.status === 'approved' || existingClaim.status === 'rejected') {
    return res.status(409).json({ message: 'A finalized claim cannot be reclassified.' });
  }
  const body = z.object({ reviewer: z.string().min(2).optional(), reason: z.string().min(1), newCategory: CategorySchema }).parse(req.body);
  const claim = structuredClone(existingClaim);
  const before = structuredClone(existingClaim);
  const originalCategory = claim.category;
  claim.category = body.newCategory;
  claim.aiReview = {
    ...(claim.aiReview || { suggestedCategory: originalCategory as any, confidence: 0, classificationUncertain: true, reviewStatus: 'clarification_required', summary: 'Classification set manually before AI review.', findings: [], missingInformation: [], clarificationQuestions: [], limitations: [], policySectionIds: [], generatedAt: new Date().toISOString(), source: 'pending' }),
    suggestedCategory: body.newCategory,
    classificationUncertain: false,
    summary: `Reviewer override from ${originalCategory} to ${body.newCategory}.`,
    generatedAt: new Date().toISOString(),
  };
  claim.reviewHistory = [...(claim.reviewHistory || []), { timestamp: new Date().toISOString(), actor: body.reviewer || 'reviewer@demo.local', action: 'classification_overridden', reason: body.reason, before, after: { ...claim } }];
  const auditEvent = createAuditEvent(body.reviewer || 'reviewer@demo.local', 'classification_overridden', claim.id, body.reason, before, { ...claim });
  await memoryStore.commitClaim(claim);
  await memoryStore.commitAudit(auditEvent);
  res.json({ data: claim });
}));

app.get('/api/dashboard/metrics', (_req, res) => {
  const claims = memoryStore.getState().claims;
  const metrics = computeDashboardMetrics(claims);
  res.json({ data: metrics });
});

app.get('/api/dashboard/recent-activity', (_req, res) => {
  const events = memoryStore.getState().auditEvents.slice(-10).reverse();
  res.json({ data: events });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) {
    return res.status(422).json({ message: 'Invalid request payload.', issues: err.issues });
  }
  const errorType = err instanceof Error ? err.name : 'UnknownError';
  console.error(`Request failed (${errorType}).`);
  res.status(500).json({ message: 'Internal server error.' });
});

export default app;
