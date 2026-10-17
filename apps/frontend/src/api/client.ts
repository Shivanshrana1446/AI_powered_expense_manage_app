import axios from 'axios';
import type { ApiHealth, DashboardMetrics, ExpenseClaim, PolicySection } from '../types';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  headers: { 'Content-Type': 'application/json', 'x-user-role': 'reviewer' },
});

export const fetchDashboardMetrics = async (): Promise<DashboardMetrics> => {
  const response = await api.get('/dashboard/metrics');
  return response.data.data;
};

export const fetchHealth = async (): Promise<ApiHealth> => {
  const response = await api.get('/health');
  return response.data;
};

export const fetchClaims = async (): Promise<ExpenseClaim[]> => {
  const response = await api.get('/claims');
  return response.data.data;
};

export const fetchPolicies = async (): Promise<PolicySection[]> => {
  const response = await api.get('/policies');
  return response.data.data;
};

export const createClaim = async (payload: Pick<ExpenseClaim, 'claimant' | 'expenseDate' | 'category' | 'amount' | 'currency' | 'description' | 'receiptAvailable'>) => {
  const response = await api.post('/claims', payload);
  return response.data.data;
};

export const submitReview = async (id: string): Promise<ExpenseClaim> => {
  const response = await api.post(`/claims/${id}/review`);
  return response.data.data;
};

export const approveClaim = async (id: string, reason: string): Promise<ExpenseClaim> => {
  const response = await api.post(`/claims/${id}/approve`, { reviewer: 'reviewer@demo.local', reason });
  return response.data.data;
};

export const rejectClaim = async (id: string, reason: string): Promise<ExpenseClaim> => {
  const response = await api.post(`/claims/${id}/reject`, { reviewer: 'reviewer@demo.local', reason });
  return response.data.data;
};

export const requestClarification = async (id: string, reason: string): Promise<ExpenseClaim> => {
  const response = await api.post(`/claims/${id}/request-clarification`, { reviewer: 'reviewer@demo.local', reason });
  return response.data.data;
};

export const overrideClassification = async (id: string, newCategory: string, reason: string): Promise<ExpenseClaim> => {
  const response = await api.post(`/claims/${id}/override-classification`, { reviewer: 'reviewer@demo.local', newCategory, reason });
  return response.data.data;
};
