import { z } from 'zod';

export const CurrencySchema = z.enum(['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'JPY']);
export const CategorySchema = z.enum(['Travel', 'Meals', 'Software', 'Office', 'Training', 'Mileage', 'Accommodation', 'Other']);
export const ClaimStatusSchema = z.enum(['draft', 'submitted', 'pending_review', 'potentially_compliant', 'missing_receipt', 'clarification_required', 'approved', 'rejected', 'needs_attention']);
export const SeveritySchema = z.enum(['info', 'warning', 'error', 'critical']);
export const PolicyStatusSchema = z.enum(['active', 'inactive']);

export const PolicySectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  policyText: z.string(),
  categories: z.array(CategorySchema),
  categoryLimits: z.array(z.object({ category: CategorySchema, maxAmount: z.number().nonnegative(), currency: CurrencySchema })).optional(),
  receiptRequired: z.boolean().default(false),
  effectiveDate: z.string(),
  status: PolicyStatusSchema.default('active'),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  version: z.number().default(1),
});

export const ClaimFindingSchema = z.object({
  code: z.string(),
  severity: SeveritySchema,
  message: z.string(),
  field: z.string().optional(),
  policySectionIds: z.array(z.string()).default([]),
  evidence: z.string().optional(),
  requiresClarification: z.boolean().default(false),
});

export const AIReviewSchema = z.object({
  suggestedCategory: CategorySchema,
  confidence: z.number().min(0).max(1),
  classificationUncertain: z.boolean().default(false),
  reviewStatus: z.enum(['potentially_compliant', 'clarification_required', 'needs_attention']),
  summary: z.string(),
  findings: z.array(ClaimFindingSchema),
  missingInformation: z.array(z.string()),
  clarificationQuestions: z.array(z.string()),
  limitations: z.array(z.string()),
  policySectionIds: z.array(z.string()).default([]),
  generatedAt: z.string(),
  source: z.enum(['mock', 'gemini', 'openai', 'unavailable', 'pending']).default('pending'),
});

export const ClaimSchema = z.object({
  id: z.string(),
  claimant: z.string().min(2),
  expenseDate: z.string(),
  category: CategorySchema,
  amount: z.number().positive(),
  currency: CurrencySchema,
  description: z.string().min(3),
  receiptAvailable: z.boolean().default(false),
  status: ClaimStatusSchema.default('submitted'),
  finalDecision: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  aiReview: AIReviewSchema.optional(),
  deterministicFindings: z.array(ClaimFindingSchema).default([]),
  reviewHistory: z.array(z.object({
    timestamp: z.string(),
    actor: z.string(),
    action: z.string(),
    reason: z.string().optional(),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
  })).default([]),
  duplicateCheck: z.object({
    exactDuplicate: z.boolean().default(false),
    possibleDuplicate: z.boolean().default(false),
    duplicateIds: z.array(z.string()).default([]),
  }).default({ exactDuplicate: false, possibleDuplicate: false, duplicateIds: [] }),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  submittedBy: z.string().default('employee'),
});

export type Currency = z.infer<typeof CurrencySchema>;
export type Category = z.infer<typeof CategorySchema>;
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;
export type PolicySection = z.infer<typeof PolicySectionSchema>;
export type ClaimFinding = z.infer<typeof ClaimFindingSchema>;
export type AIReview = z.infer<typeof AIReviewSchema>;
export type ExpenseClaim = z.infer<typeof ClaimSchema>;
export type AuditEvent = {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  reason?: string;
  claimId?: string;
  before?: unknown;
  after?: unknown;
};

export const ReviewActionSchema = z.object({
  reviewer: z.string().default('reviewer@demo.local'),
  reason: z.string().min(1),
});
