export type ClaimStatus = 'submitted' | 'pending_review' | 'potentially_compliant' | 'missing_receipt' | 'clarification_required' | 'approved' | 'rejected' | 'needs_attention';

export interface ClaimFinding {
  code: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  field?: string;
  policySectionIds: string[];
  evidence?: string;
  requiresClarification?: boolean;
}

export interface AIReview {
  suggestedCategory: string;
  confidence: number;
  classificationUncertain: boolean;
  reviewStatus: string;
  summary: string;
  findings: ClaimFinding[];
  missingInformation: string[];
  clarificationQuestions: string[];
  limitations: string[];
  policySectionIds: string[];
  generatedAt: string;
  source: string;
}

export interface ExpenseClaim {
  id: string;
  claimant: string;
  expenseDate: string;
  category: string;
  amount: number;
  currency: string;
  description: string;
  receiptAvailable: boolean;
  status: ClaimStatus;
  finalDecision: 'pending' | 'approved' | 'rejected';
  aiReview?: AIReview;
  deterministicFindings?: ClaimFinding[];
  duplicateCheck?: { exactDuplicate: boolean; possibleDuplicate: boolean; duplicateIds: string[] };
  reviewHistory?: any[];
  createdAt?: string;
  updatedAt?: string;
}

export interface PolicySection {
  id: string;
  title: string;
  summary: string;
  policyText: string;
  categories: string[];
  categoryLimits?: Array<{ category: string; maxAmount: number; currency: string }>;
  receiptRequired?: boolean;
  effectiveDate: string;
  status: 'active' | 'inactive';
  version?: number;
}

export interface DashboardMetrics {
  totalClaims: number;
  pendingReviews: number;
  approvedClaims: number;
  rejectedClaims: number;
  clarificationClaims: number;
  totalClaimAmount: number;
  statusDistribution: Record<string, number>;
}

export interface ApiHealth {
  ok: boolean;
  mode: 'demo' | 'live' | 'unavailable';
  storage: 'mongodb' | 'memory';
}
