import { AuditEvent, ExpenseClaim, PolicySection } from './types.js';
import { config } from './config.js';
import { isDatabaseConnected, persistAuditEvent, persistClaim, persistPolicy } from './models.js';

export type StoreState = {
  policies: PolicySection[];
  claims: ExpenseClaim[];
  auditEvents: AuditEvent[];
};

const state: StoreState = {
  policies: [],
  claims: [],
  auditEvents: [],
};

export const memoryStore = {
  getState: () => state,
  reset: () => {
    state.policies = [];
    state.claims = [];
    state.auditEvents = [];
  },
  seedPolicies: (policies: PolicySection[]) => {
    state.policies = policies;
  },
  seedClaims: (claims: ExpenseClaim[]) => {
    state.claims = claims;
  },
  restore: (saved: StoreState) => {
    state.policies = saved.policies;
    state.claims = saved.claims;
    state.auditEvents = saved.auditEvents;
  },
  savePolicy: (policy: PolicySection) => {
    const idx = state.policies.findIndex((p) => p.id === policy.id);
    if (idx >= 0) state.policies[idx] = policy; else state.policies.push(policy);
    return policy;
  },
  commitPolicy: async (policy: PolicySection) => {
    if (isDatabaseConnected()) await persistPolicy(policy);
    else if (config.mongoConfigured) throw new Error('MongoDB is configured but disconnected; policy was not saved.');
    return memoryStore.savePolicy(policy);
  },
  saveClaim: (claim: ExpenseClaim) => {
    const idx = state.claims.findIndex((c) => c.id === claim.id);
    if (idx >= 0) state.claims[idx] = claim; else state.claims.push(claim);
    return claim;
  },
  commitClaim: async (claim: ExpenseClaim) => {
    if (isDatabaseConnected()) await persistClaim(claim);
    else if (config.mongoConfigured) throw new Error('MongoDB is configured but disconnected; claim was not saved.');
    return memoryStore.saveClaim(claim);
  },
  saveAudit: (event: StoreState['auditEvents'][number]) => {
    state.auditEvents.push(event);
    return event;
  },
  commitAudit: async (event: AuditEvent) => {
    if (isDatabaseConnected()) await persistAuditEvent(event);
    else if (config.mongoConfigured) throw new Error('MongoDB is configured but disconnected; audit event was not saved.');
    return memoryStore.saveAudit(event);
  },
  persistPolicy: async (policy: PolicySection) => {
    if (isDatabaseConnected()) await persistPolicy(policy);
    else if (config.mongoConfigured) throw new Error('MongoDB is configured but disconnected; policy was not saved.');
  },
  persistClaim: async (claim: ExpenseClaim) => {
    if (isDatabaseConnected()) await persistClaim(claim);
    else if (config.mongoConfigured) throw new Error('MongoDB is configured but disconnected; claim was not saved.');
  },
  persistAudit: async (event: AuditEvent) => {
    if (isDatabaseConnected()) await persistAuditEvent(event);
    else if (config.mongoConfigured) throw new Error('MongoDB is configured but disconnected; audit event was not saved.');
  },
};
