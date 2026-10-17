import mongoose, { Schema, model } from 'mongoose';
import { config } from './config.js';
import { AuditEvent, ExpenseClaim, PolicySection, PolicyStatusSchema, SeveritySchema } from './types.js';

const CATEGORY_VALUES = ['Travel', 'Meals', 'Software', 'Office', 'Training', 'Mileage', 'Accommodation', 'Other'] as const;
const CURRENCY_VALUES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'JPY'] as const;

const PolicySectionSchemaDef = new Schema({
  id: { type: String, required: true, index: true },
  title: { type: String, required: true },
  summary: String,
  policyText: { type: String, required: true },
  categories: [{ type: String, enum: CATEGORY_VALUES }],
  categoryLimits: [{
    category: { type: String, enum: CATEGORY_VALUES },
    maxAmount: Number,
    currency: { type: String, enum: CURRENCY_VALUES },
  }],
  receiptRequired: Boolean,
  effectiveDate: String,
  status: { type: String, enum: PolicyStatusSchema.options, default: 'active' },
  version: Number,
  createdAt: String,
  updatedAt: String,
});

const ClaimFindingSchemaDef = new Schema({
  code: String,
  severity: { type: String, enum: SeveritySchema.options },
  message: String,
  field: String,
  policySectionIds: [String],
  evidence: String,
  requiresClarification: Boolean,
}, { _id: false });

const AIReviewSchemaDef = new Schema({
  suggestedCategory: String,
  confidence: Number,
  classificationUncertain: Boolean,
  reviewStatus: String,
  summary: String,
  findings: [ClaimFindingSchemaDef],
  missingInformation: [String],
  clarificationQuestions: [String],
  limitations: [String],
  policySectionIds: [String],
  generatedAt: String,
  source: String,
}, { _id: false });

const ClaimReviewHistoryEntrySchema = new Schema({
  timestamp: String,
  actor: String,
  action: String,
  reason: String,
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
}, { _id: false });

const ExpenseClaimSchemaDef = new Schema({
  id: { type: String, required: true, unique: true, index: true },
  claimant: { type: String, required: true, index: true },
  expenseDate: { type: String, required: true },
  category: { type: String, enum: CATEGORY_VALUES, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, enum: CURRENCY_VALUES, required: true },
  description: { type: String, required: true },
  receiptAvailable: { type: Boolean, default: false },
  status: { type: String, index: true },
  finalDecision: { type: String, default: 'pending' },
  aiReview: AIReviewSchemaDef,
  deterministicFindings: [ClaimFindingSchemaDef],
  reviewHistory: [ClaimReviewHistoryEntrySchema],
  duplicateCheck: {
    exactDuplicate: Boolean,
    possibleDuplicate: Boolean,
    duplicateIds: [String],
  },
  submittedBy: String,
  createdAt: String,
  updatedAt: String,
});

const ClaimReviewSchemaDef = new Schema({
  claimId: { type: String, required: true, index: true },
  reviewer: { type: String, required: true },
  action: { type: String, required: true },
  reason: String,
  createdAt: { type: Date, default: Date.now },
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
});

const AuditEventSchemaDef = new Schema({
  id: { type: String, required: true, unique: true },
  timestamp: { type: String, required: true },
  actor: { type: String, required: true },
  action: { type: String, required: true },
  reason: String,
  claimId: String,
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
});

export const PolicySectionModel = model('PolicySection', PolicySectionSchemaDef);
export const ExpenseClaimModel = model('ExpenseClaim', ExpenseClaimSchemaDef);
export const ClaimReviewModel = model('ClaimReview', ClaimReviewSchemaDef);
export const AuditEventModel = model('AuditEvent', AuditEventSchemaDef);

export const connectDatabase = async () => {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(config.mongoUri);
};

export const isDatabaseConnected = () => mongoose.connection.readyState === 1;

export const loadDatabaseState = async () => {
  const [policies, claims, auditEvents] = await Promise.all([
    PolicySectionModel.find().lean().exec(),
    ExpenseClaimModel.find().lean().exec(),
    AuditEventModel.find().lean().exec(),
  ]);

  return {
    policies: policies.map(({ _id, __v, ...policy }) => policy as unknown as PolicySection),
    claims: claims.map(({ _id, __v, ...claim }) => claim as unknown as ExpenseClaim),
    auditEvents: auditEvents.map(({ _id, __v, ...event }) => event as unknown as AuditEvent),
  };
};

export const persistPolicy = async (policy: PolicySection) => {
  await PolicySectionModel.findOneAndUpdate({ id: policy.id }, policy, { upsert: true, new: true }).exec();
};

export const persistClaim = async (claim: ExpenseClaim) => {
  const { aiReview, ...claimFields } = claim;
  const update = aiReview
    ? { $set: claim }
    : { $set: claimFields, $unset: { aiReview: 1 } };
  await ExpenseClaimModel.findOneAndUpdate({ id: claim.id }, update, { upsert: true, new: true }).exec();
};

export const persistAuditEvent = async (event: AuditEvent) => {
  await AuditEventModel.findOneAndUpdate({ id: event.id }, event, { upsert: true, new: true }).exec();
};
