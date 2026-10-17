import { memoryStore } from './store.js';
import { config } from './config.js';
import { AIReview, ExpenseClaim, PolicySection } from './types.js';
import { runDeterministicValidation, detectDuplicateClaims } from './services/validation.js';
import { performAIReview } from './services/ai.js';
import { connectDatabase, isDatabaseConnected, loadDatabaseState } from './models.js';

const policySections: PolicySection[] = [
  { id: 'TRAVEL-01', title: 'Travel and mileage policy', summary: 'Travel reimbursement requires a receipt for flights or accommodation.', policyText: 'Travel and accommodation expenses are covered when they are reasonable and supported by a receipt. Airfare and hotel costs require receipts and must be tied to approved business travel. For mileage, the rate is capped at 0.67 USD per mile.', categories: ['Travel', 'Mileage', 'Accommodation'], categoryLimits: [{ category: 'Travel', maxAmount: 1200, currency: 'USD' }, { category: 'Accommodation', maxAmount: 1600, currency: 'USD' }, { category: 'Mileage', maxAmount: 500, currency: 'USD' }], receiptRequired: true, effectiveDate: '2025-01-01', status: 'active', version: 1 },
  { id: 'MEALS-01', title: 'Meals policy', summary: 'Meal expenses require productively documented business purpose.', policyText: 'Meals are reimbursable when they are directly related to business development, client meetings, or travel. Receipts are required if the meal exceeds 25 USD. Do not claim alcohol or entertainment expenses.', categories: ['Meals'], categoryLimits: [{ category: 'Meals', maxAmount: 250, currency: 'USD' }], receiptRequired: false, effectiveDate: '2025-01-01', status: 'active', version: 1 },
  { id: 'SW-01', title: 'Software and subscriptions', summary: 'Software expenses require a business justification and approved vendor.', policyText: 'Software subscriptions are reimbursable where they support work productivity and are approved by the team lead. Single-item software charges with recurring monthly fees require proof of business necessity.', categories: ['Software'], categoryLimits: [{ category: 'Software', maxAmount: 800, currency: 'USD' }], receiptRequired: true, effectiveDate: '2025-01-01', status: 'active', version: 1 },
  { id: 'OFFICE-01', title: 'Office and supplies', summary: 'Office related purchases are limited to business use.', policyText: 'Office supplies and consumables are reimbursable when used for work and are limited to ordinary business needs. Keep receipts for all supply purchases.', categories: ['Office'], categoryLimits: [{ category: 'Office', maxAmount: 200, currency: 'USD' }], receiptRequired: true, effectiveDate: '2025-01-01', status: 'active', version: 1 },
  { id: 'TRAIN-01', title: 'Training and conferences policy', summary: 'Training must be approved and associated with role development.', policyText: 'Training and conference costs are reimbursable only when directly tied to a role or certification requirement and approved in advance. Receipts are required for registration and travel associated with training.', categories: ['Training'], categoryLimits: [{ category: 'Training', maxAmount: 600, currency: 'USD' }], receiptRequired: true, effectiveDate: '2025-01-01', status: 'active', version: 1 },
  { id: 'GEN-01', title: 'General policy', summary: 'Other expenses require clear business purpose and approval.', policyText: 'Other expenses are only reimbursable when there is a clear business purpose, a dated receipt or proof-of-payment, and manager approval.', categories: ['Other'], categoryLimits: [{ category: 'Other', maxAmount: 300, currency: 'USD' }], receiptRequired: true, effectiveDate: '2025-01-01', status: 'active', version: 1 },
];

const sampleClaims: ExpenseClaim[] = [
  { id: 'CLM-001', claimant: 'Aisha Khan', expenseDate: '2026-09-10', category: 'Travel', amount: 540, currency: 'USD', description: 'Client travel to San Francisco for stakeholder workshop', receiptAvailable: true, status: 'approved', finalDecision: 'approved', deterministicFindings: [], duplicateCheck: { exactDuplicate: false, possibleDuplicate: false, duplicateIds: [] }, reviewHistory: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), submittedBy: 'employee', },
  { id: 'CLM-002', claimant: 'Aisha Khan', expenseDate: '2026-09-10', category: 'Travel', amount: 540, currency: 'USD', description: 'Client travel to San Francisco for stakeholder workshop', receiptAvailable: true, status: 'pending_review', finalDecision: 'pending', deterministicFindings: [], duplicateCheck: { exactDuplicate: true, possibleDuplicate: true, duplicateIds: ['CLM-001'] }, reviewHistory: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), submittedBy: 'employee', },
  { id: 'CLM-003', claimant: 'Liam Chen', expenseDate: '2026-08-21', category: 'Meals', amount: 120, currency: 'USD', description: 'Dinner with vendor team in Manhattan', receiptAvailable: false, status: 'missing_receipt', finalDecision: 'pending', deterministicFindings: [], duplicateCheck: { exactDuplicate: false, possibleDuplicate: false, duplicateIds: [] }, reviewHistory: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), submittedBy: 'employee', },
  { id: 'CLM-004', claimant: 'Marta Silva', expenseDate: '2026-09-15', category: 'Software', amount: 250, currency: 'USD', description: 'Adobe Creative Cloud monthly subscription for design work', receiptAvailable: true, status: 'potentially_compliant', finalDecision: 'pending', deterministicFindings: [], duplicateCheck: { exactDuplicate: false, possibleDuplicate: false, duplicateIds: [] }, reviewHistory: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), submittedBy: 'employee', },
  { id: 'CLM-005', claimant: 'Nia Patel', expenseDate: '2026-09-17', category: 'Accommodation', amount: 1750, currency: 'USD', description: 'Hotel stay in Seattle for customer kickoff', receiptAvailable: true, status: 'needs_attention', finalDecision: 'pending', deterministicFindings: [], duplicateCheck: { exactDuplicate: false, possibleDuplicate: false, duplicateIds: [] }, reviewHistory: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), submittedBy: 'employee', },
  { id: 'CLM-006', claimant: 'Omar Hassan', expenseDate: '2026-09-05', category: 'Training', amount: 620, currency: 'USD', description: 'Conference registration and hotel for a course on AI risk management', receiptAvailable: true, status: 'clarification_required', finalDecision: 'pending', deterministicFindings: [], duplicateCheck: { exactDuplicate: false, possibleDuplicate: false, duplicateIds: [] }, reviewHistory: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), submittedBy: 'employee', },
  { id: 'CLM-007', claimant: 'Priya Nair', expenseDate: '2026-09-18', category: 'Office', amount: 195, currency: 'USD', description: 'Office chairs for remote team setup', receiptAvailable: true, status: 'rejected', finalDecision: 'rejected', deterministicFindings: [], duplicateCheck: { exactDuplicate: false, possibleDuplicate: false, duplicateIds: [] }, reviewHistory: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), submittedBy: 'employee', },
  { id: 'CLM-008', claimant: 'Ravi Singh', expenseDate: '2026-09-19', category: 'Other', amount: 280, currency: 'USD', description: 'Various team snacks for offsite event', receiptAvailable: false, status: 'pending_review', finalDecision: 'pending', deterministicFindings: [], duplicateCheck: { exactDuplicate: false, possibleDuplicate: false, duplicateIds: [] }, reviewHistory: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), submittedBy: 'employee', },
];

export const seedDatabase = async () => {
  if (isDatabaseConnected()) {
    memoryStore.restore(await loadDatabaseState());
    if (memoryStore.getState().policies.length === 0) {
      memoryStore.seedPolicies(policySections);
      await Promise.all(policySections.map((policy) => memoryStore.persistPolicy(policy)));
    }
  } else {
    memoryStore.reset();
    memoryStore.seedPolicies(policySections);
  }

  if (memoryStore.getState().claims.length > 0) return;

  for (const claim of sampleClaims) {
    const withDuplicates = { ...claim };
    const existingClaims = memoryStore.getState().claims;
    withDuplicates.duplicateCheck = detectDuplicateClaims(withDuplicates, [...existingClaims, ...sampleClaims.filter((item) => item.id !== withDuplicates.id)]);
    withDuplicates.deterministicFindings = runDeterministicValidation(withDuplicates, memoryStore.getState().policies);
    withDuplicates.aiReview = config.demoMode
      ? await performAIReview(withDuplicates, memoryStore.getState().policies)
      : ({
          suggestedCategory: withDuplicates.category,
          confidence: 0,
          classificationUncertain: true,
          reviewStatus: 'clarification_required',
          summary: 'AI review has not been run for this seeded example.',
          findings: [],
          missingInformation: [],
          clarificationQuestions: [],
          limitations: ['Run AI review to request a live provider assessment.'],
          policySectionIds: [],
          generatedAt: new Date().toISOString(),
          source: 'pending',
        } satisfies AIReview);
    withDuplicates.status = withDuplicates.aiReview.reviewStatus === 'potentially_compliant' ? 'potentially_compliant' : withDuplicates.status;
    if (withDuplicates.deterministicFindings.some((finding) => finding.severity === 'error')) withDuplicates.status = 'needs_attention';
    memoryStore.saveClaim(withDuplicates);
    await memoryStore.persistClaim(withDuplicates);
  }
};

if (process.argv.includes('--run')) {
  connectDatabase()
    .then(seedDatabase)
    .catch((error) => {
      const errorType = error instanceof Error ? error.name : 'UnknownError';
      console.error(`Failed to seed database (${errorType}).`);
      process.exitCode = 1;
    })
    .finally(async () => {
      const mongoose = await import('mongoose');
      await mongoose.default.disconnect();
    });
}
