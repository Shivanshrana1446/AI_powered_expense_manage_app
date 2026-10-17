import { ClaimFinding, ExpenseClaim, PolicySection } from '../types.js';

const supportedCurrencies = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'JPY'] as const;
const categoryLimitsByCategory: Record<string, number> = {
  Travel: 1200,
  Accommodation: 1600,
  Meals: 250,
  Software: 800,
  Office: 200,
  Training: 600,
  Mileage: 500,
  Other: 300,
};

export const normalizeText = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
const isValidExpenseDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const buildFingerprint = (claim: Pick<ExpenseClaim, 'claimant' | 'expenseDate' | 'amount' | 'currency' | 'category' | 'description'>) => {
  const claimant = normalizeText(claim.claimant);
  const date = claim.expenseDate;
  const currency = claim.currency;
  const desc = normalizeText(claim.description);
  return `${claimant}|${date}|${claim.amount.toFixed(2)}|${currency}|${claim.category}|${desc}`;
};

export const validateClaimInput = (payload: Partial<ExpenseClaim>) => {
  const findings: ClaimFinding[] = [];

  if (!payload.claimant || String(payload.claimant).trim().length < 2) {
    findings.push({ code: 'required_claimant', severity: 'error', message: 'Claimant is required.', field: 'claimant', policySectionIds: [], requiresClarification: false });
  }
  if (typeof payload.expenseDate !== 'string' || !isValidExpenseDate(payload.expenseDate)) {
    findings.push({ code: 'invalid_date', severity: 'error', message: 'Expense date is invalid.', field: 'expenseDate', policySectionIds: [], requiresClarification: false });
  }
  if (!payload.category) {
    findings.push({ code: 'required_category', severity: 'error', message: 'Expense category is required.', field: 'category', policySectionIds: [], requiresClarification: false });
  }
  if (payload.amount === undefined || Number(payload.amount) <= 0) {
    findings.push({ code: 'invalid_amount', severity: 'error', message: 'Amount must be a positive number.', field: 'amount', policySectionIds: [], requiresClarification: false });
  }
  if (!payload.currency || !supportedCurrencies.includes(payload.currency as any)) {
    findings.push({ code: 'invalid_currency', severity: 'error', message: 'Unsupported currency.', field: 'currency', policySectionIds: [], requiresClarification: false });
  }
  if (!payload.description || String(payload.description).trim().length < 3) {
    findings.push({ code: 'required_description', severity: 'error', message: 'Description is required.', field: 'description', policySectionIds: [], requiresClarification: false });
  }

  return findings;
};

export const detectDuplicateClaims = (current: ExpenseClaim, allClaims: ExpenseClaim[], threshold = 0.6) => {
  const candidates = allClaims.filter((claim) => claim.id !== current.id);
  const exactMatches = candidates.filter((c) => buildFingerprint(c) === buildFingerprint(current));
  const possibleMatches = candidates.filter((c) => {
    const sameClaimant = normalizeText(c.claimant) === normalizeText(current.claimant);
    const sameDate = c.expenseDate === current.expenseDate;
    const sameCurrency = c.currency === current.currency;
    const sameCategory = c.category === current.category;
    const similarAmount = Math.abs(c.amount - current.amount) / Math.max(c.amount, current.amount) <= threshold;
    const sameDescription = normalizeText(c.description).includes(normalizeText(current.description)) || normalizeText(current.description).includes(normalizeText(c.description));
    return sameClaimant && sameDate && sameCategory && sameCurrency && (similarAmount || sameDescription);
  });

  return {
    exactDuplicate: exactMatches.length > 0,
    possibleDuplicate: possibleMatches.length > 0,
    duplicateIds: [...new Set([...exactMatches.map((c) => c.id), ...possibleMatches.map((c) => c.id)])],
  };
};

export const runDeterministicValidation = (claim: ExpenseClaim, policies: PolicySection[]): ClaimFinding[] => {
  const findings: ClaimFinding[] = [];
  const activePolicies = policies.filter((p) => p.status === 'active');
  const categoryPolicy = activePolicies.find((p) => p.categories.includes(claim.category));
  const categoryPolicyIds = categoryPolicy ? [categoryPolicy.id] : [];

  const mealReceiptRequired = claim.category === 'Meals' && claim.amount > 25;
  if (categoryPolicy && (categoryPolicy.receiptRequired || mealReceiptRequired) && !claim.receiptAvailable) {
    findings.push({
      code: 'missing_receipt',
      severity: 'warning',
      message: 'A receipt is required for this category and was not provided.',
      field: 'receiptAvailable',
      policySectionIds: categoryPolicyIds,
      evidence: categoryPolicy.policyText,
      requiresClarification: true,
    });
  }

  const categoryLimit = categoryPolicy?.categoryLimits?.find((limit) => limit.category === claim.category && limit.currency === claim.currency);
  if (categoryLimit && claim.amount > categoryLimit.maxAmount) {
    findings.push({
      code: 'category_limit_exceeded',
      severity: 'error',
      message: `Claim exceeds the configured limit for ${claim.category}.`,
      field: 'amount',
      policySectionIds: categoryPolicyIds,
      evidence: categoryPolicy ? categoryPolicy.policyText : 'Limit configured in policy.',
      requiresClarification: true,
    });
  }

  if (claim.duplicateCheck.exactDuplicate) {
    findings.push({
      code: 'duplicate_exact',
      severity: 'error',
      message: 'This claim matches an exact duplicate in the system.',
      field: 'description',
      policySectionIds: [],
      evidence: 'Duplicate detection rule applied to normalized claimant, date, amount, category, and description.',
      requiresClarification: false,
    });
  } else if (claim.duplicateCheck.possibleDuplicate) {
    findings.push({
      code: 'duplicate_possible',
      severity: 'warning',
      message: 'This claim is similar to a prior entry and may require review.',
      field: 'description',
      policySectionIds: [],
      evidence: 'Possible duplicate check used claimant, date, amount, currency, description, and category similarity.',
      requiresClarification: true,
    });
  }

  if (claim.amount > categoryLimitsByCategory[claim.category] || claim.amount > 5000) {
    findings.push({
      code: 'manual_review_threshold',
      severity: 'warning',
      message: 'The amount triggers a manual reviewer check.',
      field: 'amount',
      policySectionIds: categoryPolicyIds,
      evidence: categoryPolicy?.policyText || 'Amount review threshold is applied to high-value claims.',
      requiresClarification: claim.amount > 5000,
    });
  }

  return findings;
};

export const computeDashboardMetrics = (claims: ExpenseClaim[]) => {
  const totals = { total: 0, approved: 0, rejected: 0, pending: 0, clarification: 0, amount: 0 };
  const byStatus: Record<string, number> = {};

  claims.forEach((claim) => {
    totals.total += 1;
    totals.amount += claim.amount;
    byStatus[claim.status] = (byStatus[claim.status] || 0) + 1;

    if (claim.status === 'approved') totals.approved += 1;
    if (claim.status === 'rejected') totals.rejected += 1;
    if (claim.status === 'pending_review' || claim.status === 'submitted') totals.pending += 1;
    if (claim.status === 'clarification_required') totals.clarification += 1;
  });

  return {
    totalClaims: totals.total,
    pendingReviews: totals.pending,
    approvedClaims: totals.approved,
    rejectedClaims: totals.rejected,
    clarificationClaims: totals.clarification,
    totalClaimAmount: totals.amount,
    statusDistribution: byStatus,
  };
};

export const summarizeTotalsByCurrency = (claims: ExpenseClaim[]) => {
  const totals: Record<string, number> = {};
  claims.forEach((claim) => {
    totals[claim.currency] = (totals[claim.currency] || 0) + claim.amount;
  });
  return totals;
};
