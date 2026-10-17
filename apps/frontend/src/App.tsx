import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowRightLeft, BadgeCheck, BriefcaseBusiness, Building2, CheckCircle2, ClipboardList, Download, FileText, Layers3, ShieldCheck, Ticket, TrendingUp, UserRound } from 'lucide-react';
import { api, approveClaim, createClaim, fetchClaims, fetchDashboardMetrics, fetchPolicies, rejectClaim, requestClarification, submitReview, overrideClassification } from './api/client';
import type { DashboardMetrics, ExpenseClaim, PolicySection } from './types';

const navItems = [
  { key: 'dashboard', label: 'Dashboard', icon: TrendingUp },
  { key: 'claims', label: 'Claims', icon: ClipboardList },
  { key: 'submit', label: 'Submit Claim', icon: FileText },
  { key: 'queue', label: 'Review Queue', icon: ShieldCheck },
  { key: 'policies', label: 'Policy Management', icon: Layers3 },
];

const defaultClaimForm = {
  claimant: '',
  expenseDate: '',
  category: 'Travel',
  amount: '',
  currency: 'USD',
  description: '',
  receiptAvailable: true,
};

const statusColors: Record<string, string> = {
  approved: '#16a34a',
  rejected: '#dc2626',
  pending_review: '#3b82f6',
  clarification_required: '#f59e0b',
  needs_attention: '#ef4444',
  potentially_compliant: '#14b8a6',
  submitted: '#6366f1',
  missing_receipt: '#f97316',
};

const getReviewSourceLabel = (source?: string, pendingLabel = 'Not reviewed') => {
  switch (source) {
    case 'mock':
      return 'Demo review';
    case 'automated':
      return 'Automated review';
    case 'unavailable':
      return 'Unavailable';
    default:
      return pendingLabel;
  }
};

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [claims, setClaims] = useState<ExpenseClaim[]>([]);
  const [policies, setPolicies] = useState<PolicySection[]>([]);
  const [selectedClaim, setSelectedClaim] = useState<ExpenseClaim | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [claimForm, setClaimForm] = useState(defaultClaimForm);
  const [policyForm, setPolicyForm] = useState({ title: '', summary: '', policyText: '', categories: 'Travel,Meals', receiptRequired: true, effectiveDate: '2026-01-01' });
  const [overrideCategory, setOverrideCategory] = useState<string | null>(null);

  const loadData = async () => {
    const [metricsData, claimsData, policyData] = await Promise.all([
      fetchDashboardMetrics(),
      fetchClaims(),
      fetchPolicies(),
    ]);
    setMetrics(metricsData);
    setClaims(claimsData);
    setPolicies(policyData);
    const currentSelectedClaim = claimsData.find((claim) => claim.id === selectedClaim?.id);
    setSelectedClaim(currentSelectedClaim || claimsData[0] || null);
  };

  useEffect(() => { void loadData(); }, []);

  const filteredClaims = useMemo(() => {
    return claims.filter((claim) => {
      const matchesSearch = [claim.claimant, claim.id, claim.category].join(' ').toLowerCase().includes(search.toLowerCase());
      const matchesStatus = statusFilter === 'all' || claim.status === statusFilter;
      const matchesCategory = categoryFilter === 'all' || claim.category === categoryFilter;
      return matchesSearch && matchesStatus && matchesCategory;
    });
  }, [claims, search, statusFilter, categoryFilter]);

  const pageSize = 6;
  const pagedClaims = filteredClaims.slice((page - 1) * pageSize, page * pageSize);
  const totalPages = Math.max(1, Math.ceil(filteredClaims.length / pageSize));

  const barData = Object.entries(metrics?.statusDistribution || {}).map(([name, value]) => ({ name, value }));
  const pieData = [
    { name: 'Approved', value: metrics?.approvedClaims || 0, color: '#16a34a' },
    { name: 'Pending', value: metrics?.pendingReviews || 0, color: '#3b82f6' },
    { name: 'Rejected', value: metrics?.rejectedClaims || 0, color: '#dc2626' },
  ];

  const handleSubmitClaim = async (event: React.FormEvent) => {
    event.preventDefault();
    const payload = {
      claimant: claimForm.claimant,
      expenseDate: claimForm.expenseDate,
      category: claimForm.category,
      amount: Number(claimForm.amount),
      currency: claimForm.currency,
      description: claimForm.description,
      receiptAvailable: claimForm.receiptAvailable,
    };
    await createClaim(payload);
    setClaimForm(defaultClaimForm);
    await loadData();
    setActiveTab('claims');
  };

  const handleCreatePolicy = async (event: React.FormEvent) => {
    event.preventDefault();
    await api.post('/policies', {
      title: policyForm.title,
      summary: policyForm.summary,
      policyText: policyForm.policyText,
      categories: policyForm.categories.split(',').map((c) => c.trim()).filter(Boolean),
      categoryLimits: [{ category: 'Travel', maxAmount: 1200, currency: 'USD' }],
      receiptRequired: policyForm.receiptRequired,
      effectiveDate: policyForm.effectiveDate,
      status: 'active',
    });
    setPolicyForm({ title: '', summary: '', policyText: '', categories: 'Travel,Meals', receiptRequired: true, effectiveDate: '2026-01-01' });
    await loadData();
  };

  const reviewClaim = async (claimId: string) => {
    const updated = await submitReview(claimId);
    setSelectedClaim(updated);
    await loadData();
  };

  const performDecision = async (action: 'approve' | 'reject' | 'clarify', claimId: string, reason: string = 'Reviewed by finance operations.') => {
    if (action === 'approve') {
      const updated = await approveClaim(claimId, reason);
      setSelectedClaim(updated);
    }
    if (action === 'reject') {
      const updated = await rejectClaim(claimId, reason);
      setSelectedClaim(updated);
    }
    if (action === 'clarify') {
      const updated = await requestClarification(claimId, reason);
      setSelectedClaim(updated);
    }
    await loadData();
  };

  const override = async (claimId: string, newCategory: string) => {
    const updated = await overrideClassification(claimId, newCategory, 'Reviewer changed the classification after checking policy context.');
    setSelectedClaim(updated);
    setOverrideCategory(null);
    await loadData();
  };

  const renderDashboard = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
        {[
          { label: 'Total Claims', value: metrics?.totalClaims || 0, icon: Ticket },
          { label: 'Pending', value: metrics?.pendingReviews || 0, icon: ClipboardList },
          { label: 'Approved', value: metrics?.approvedClaims || 0, icon: BadgeCheck },
          { label: 'Rejected', value: metrics?.rejectedClaims || 0, icon: Building2 },
          { label: 'Total Claimed', value: `$${(metrics?.totalClaimAmount || 0).toFixed(0)}`, icon: TrendingUp },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-soft">
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-500">{label}</p>
              <Icon className="h-5 w-5 text-accent" />
            </div>
            <h3 className="mt-4 text-3xl font-semibold text-slate-900">{value}</h3>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-soft xl:col-span-2">
          <h3 className="mb-4 text-lg font-semibold">Recent claims</h3>
          <div className="space-y-3">
            {(claims || []).slice(0, 5).map((claim) => (
              <div key={claim.id} className="flex items-center justify-between rounded-xl border border-slate-200 p-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{claim.id}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{claim.category}</span>
                  </div>
                  <p className="text-sm text-slate-500">{claim.claimant}</p>
                </div>
                <div className="text-right">
                  <p className="font-medium">{claim.currency} {claim.amount}</p>
                  <span className="inline-flex rounded-full px-2 py-1 text-xs font-medium" style={{ backgroundColor: `${statusColors[claim.status] || '#e2e8f0'}22`, color: statusColors[claim.status] || '#334155' }}>{claim.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-soft">
          <h3 className="mb-4 text-lg font-semibold">Status distribution</h3>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={40} outerRadius={70} fill="#8884d8">
                  {pieData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-soft">
        <h3 className="mb-4 text-lg font-semibold">Recent reviewer activity</h3>
        <div className="space-y-3">
          {(claims || []).slice(0, 4).map((claim) => (
            <div key={`activity-${claim.id}`} className="flex items-center justify-between border-b last:border-b-0 border-slate-100 py-2">
              <div>
                <p className="font-medium">{claim.claimant}</p>
                <p className="text-sm text-slate-500">{claim.status}</p>
              </div>
              <span className="text-sm text-slate-500">{claim.expenseDate}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const renderClaims = () => (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <input value={search} onChange={(e) => setSearch(e.target.value)} className="w-full rounded-xl border border-slate-200 p-3 lg:max-w-xs" placeholder="Search claims" />
        <div className="flex gap-3">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-xl border border-slate-200 p-3">
            <option value="all">All statuses</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="pending_review">Pending review</option>
            <option value="clarification_required">Clarification required</option>
          </select>
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="rounded-xl border border-slate-200 p-3">
            <option value="all">All categories</option>
            {['Travel', 'Meals', 'Software', 'Office', 'Training', 'Mileage', 'Accommodation', 'Other'].map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-soft">
        <table className="min-w-full text-left">
          <thead className="bg-slate-50 text-sm uppercase text-slate-600">
            <tr>
              <th className="p-4">Claim ID</th>
              <th className="p-4">Claimant</th>
              <th className="p-4">Submitted</th>
              <th className="p-4">Category</th>
              <th className="p-4">Amount</th>
              <th className="p-4">Receipt</th>
              <th className="p-4">Policy Review</th>
              <th className="p-4">Decision</th>
              <th className="p-4">Action</th>
            </tr>
          </thead>
          <tbody>
            {pagedClaims.map((claim) => (
              <tr key={claim.id} className="border-t border-slate-100">
                <td className="p-4 font-medium">{claim.id}</td>
                <td className="p-4">{claim.claimant}</td>
                <td className="p-4">{claim.expenseDate}</td>
                <td className="p-4">{claim.category}</td>
                <td className="p-4">{claim.currency} {claim.amount}</td>
                <td className="p-4">{claim.receiptAvailable ? 'Yes' : 'No'}</td>
                <td className="p-4"><div className="flex flex-col gap-1"><span className="rounded-full bg-slate-100 px-2 py-1 text-xs">{claim.aiReview?.reviewStatus || claim.status}</span><span className="text-[10px] uppercase tracking-wide text-slate-500">{getReviewSourceLabel(claim.aiReview?.source, 'Pending')}</span></div></td>
                <td className="p-4"><span className="rounded-full px-2 py-1 text-xs" style={{ backgroundColor: `${statusColors[claim.status] || '#e2e8f0'}22`, color: statusColors[claim.status] || '#334155' }}>{claim.status}</span></td>
                <td className="p-4"><button onClick={() => setSelectedClaim(claim)} className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white">Details</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-between">
        <button onClick={() => setPage((p) => Math.max(1, p - 1))} className="rounded-xl border px-3 py-2">Previous</button>
        <span className="self-center">Page {page} of {totalPages}</span>
        <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className="rounded-xl border px-3 py-2">Next</button>
      </div>
    </div>
  );

  const renderSubmit = () => (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-soft">
      <h3 className="mb-5 text-xl font-semibold">Submit an expense claim</h3>
      <form onSubmit={handleSubmitClaim} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="block"><span className="mb-1 block text-sm font-medium">Claimant name</span><input value={claimForm.claimant} onChange={(e) => setClaimForm({ ...claimForm, claimant: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3" /></label>
        <label className="block"><span className="mb-1 block text-sm font-medium">Expense date</span><input type="date" value={claimForm.expenseDate} onChange={(e) => setClaimForm({ ...claimForm, expenseDate: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3" /></label>
        <label className="block"><span className="mb-1 block text-sm font-medium">Category</span><select value={claimForm.category} onChange={(e) => setClaimForm({ ...claimForm, category: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3"><option>Travel</option><option>Meals</option><option>Software</option><option>Office</option><option>Training</option><option>Mileage</option><option>Accommodation</option><option>Other</option></select></label>
        <label className="block"><span className="mb-1 block text-sm font-medium">Currency</span><select value={claimForm.currency} onChange={(e) => setClaimForm({ ...claimForm, currency: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3"><option>USD</option><option>EUR</option><option>GBP</option><option>AUD</option><option>CAD</option><option>JPY</option></select></label>
        <label className="block"><span className="mb-1 block text-sm font-medium">Amount</span><input type="number" value={claimForm.amount} onChange={(e) => setClaimForm({ ...claimForm, amount: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3" /></label>
        <label className="block"><span className="mb-1 block text-sm font-medium">Receipt available</span><select value={String(claimForm.receiptAvailable)} onChange={(e) => setClaimForm({ ...claimForm, receiptAvailable: e.target.value === 'true' })} className="w-full rounded-xl border border-slate-200 p-3"><option value="true">Yes</option><option value="false">No</option></select></label>
        <label className="md:col-span-2 block"><span className="mb-1 block text-sm font-medium">Description</span><textarea value={claimForm.description} onChange={(e) => setClaimForm({ ...claimForm, description: e.target.value })} className="min-h-28 w-full rounded-xl border border-slate-200 p-3" /></label>
        <div className="md:col-span-2 flex justify-end"><button type="submit" className="rounded-xl bg-accent px-5 py-3 font-medium text-white">Submit claim</button></div>
      </form>
    </div>
  );

  const renderPolicies = () => (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-soft">
        <h3 className="mb-4 text-xl font-semibold">Policy sections</h3>
        <div className="space-y-3">
          {policies.map((policy) => (
            <div key={policy.id} className="rounded-xl border border-slate-200 p-3">
              <div className="flex justify-between"><span className="font-medium">{policy.id}</span><span className="rounded-full bg-slate-100 px-2 py-1 text-xs">{policy.status}</span></div>
              <p className="mt-2 text-sm text-slate-700">{policy.title}</p>
              <p className="mt-2 text-sm text-slate-500">{policy.summary}</p>
            </div>
          ))}
        </div>
      </div>
      <form onSubmit={handleCreatePolicy} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-soft">
        <h3 className="mb-4 text-xl font-semibold">Add policy section</h3>
        <div className="space-y-3">
          <input value={policyForm.title} onChange={(e) => setPolicyForm({ ...policyForm, title: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3" placeholder="Title" />
          <input value={policyForm.summary} onChange={(e) => setPolicyForm({ ...policyForm, summary: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3" placeholder="Summary" />
          <textarea value={policyForm.policyText} onChange={(e) => setPolicyForm({ ...policyForm, policyText: e.target.value })} className="min-h-28 w-full rounded-xl border border-slate-200 p-3" placeholder="Policy text" />
          <input value={policyForm.categories} onChange={(e) => setPolicyForm({ ...policyForm, categories: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3" placeholder="Categories (comma separated)" />
          <label className="flex items-center gap-2"><input type="checkbox" checked={policyForm.receiptRequired} onChange={(e) => setPolicyForm({ ...policyForm, receiptRequired: e.target.checked })} /> Requires receipt</label>
          <input type="date" value={policyForm.effectiveDate} onChange={(e) => setPolicyForm({ ...policyForm, effectiveDate: e.target.value })} className="w-full rounded-xl border border-slate-200 p-3" />
          <button type="submit" className="w-full rounded-xl bg-accent px-4 py-3 font-medium text-white">Save policy</button>
        </div>
      </form>
    </div>
  );

  const renderQueue = () => (
    <div className="space-y-4">
      {claims.filter((claim) => ['pending_review', 'clarification_required', 'needs_attention', 'missing_receipt'].includes(claim.status)).map((claim) => (
        <div key={claim.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-soft">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-semibold">{claim.id}</h3>
                <span className="rounded-full px-2 py-1 text-xs font-medium" style={{ backgroundColor: `${statusColors[claim.status] || '#e2e8f0'}22`, color: statusColors[claim.status] || '#334155' }}>{claim.status}</span>
              </div>
              <p className="mt-1 text-sm text-slate-500">{claim.claimant} • {claim.category} • {claim.currency} {claim.amount}</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => reviewClaim(claim.id)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm">Review</button>
              <button onClick={() => performDecision('clarify', claim.id, 'Please provide additional information for this claim.')} className="rounded-xl border border-amber-300 px-3 py-2 text-sm text-amber-800">Request clarification</button>
              <button onClick={() => performDecision('approve', claim.id)} className="rounded-xl bg-success px-3 py-2 text-sm text-white">Approve</button>
              <button onClick={() => performDecision('reject', claim.id, 'Policy violation identified.')} className="rounded-xl bg-danger px-3 py-2 text-sm text-white">Reject</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="flex min-h-screen">
        <aside className="w-full max-w-[260px] bg-navy p-5 text-white">
          <div className="mb-8 flex items-center gap-3">
            <div className="rounded-xl bg-white/10 p-2"><BriefcaseBusiness className="h-5 w-5" /></div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-300">Finance Ops</p>
              <h1 className="text-lg font-semibold">Expense Review</h1>
            </div>
          </div>
          <nav className="space-y-2">
            {navItems.map(({ key, label, icon: Icon }) => (
              <button key={key} onClick={() => setActiveTab(key)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left ${activeTab === key ? 'bg-white/10' : 'text-slate-200 hover:bg-white/5'}`}>
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="flex-1 p-6">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.2em] text-slate-500">Policy review assistant</p>
              <h2 className="text-2xl font-semibold">{navItems.find((item) => item.key === activeTab)?.label}</h2>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 shadow-soft">
              <UserRound className="h-4 w-4 text-slate-500" />
              <span className="text-sm">Finance reviewer</span>
            </div>
          </div>
          {activeTab === 'dashboard' && renderDashboard()}
          {activeTab === 'claims' && renderClaims()}
          {activeTab === 'submit' && renderSubmit()}
          {activeTab === 'queue' && renderQueue()}
          {activeTab === 'policies' && renderPolicies()}

          {selectedClaim && (
            <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-soft">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Claim details</p>
                  <h3 className="text-xl font-semibold">{selectedClaim.id}</h3>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => reviewClaim(selectedClaim.id)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm">Run policy review</button>
                  <button onClick={() => performDecision('approve', selectedClaim.id)} className="rounded-xl bg-success px-3 py-2 text-sm text-white">Approve</button>
                  <button onClick={() => performDecision('reject', selectedClaim.id, 'Reason for rejection')} className="rounded-xl bg-danger px-3 py-2 text-sm text-white">Reject</button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <p><strong>Claimant:</strong> {selectedClaim.claimant}</p>
                  <p><strong>Category:</strong> {selectedClaim.category}</p>
                  <p><strong>Date:</strong> {selectedClaim.expenseDate}</p>
                  <p><strong>Amount:</strong> {selectedClaim.currency} {selectedClaim.amount}</p>
                </div>
                <div className="space-y-2">
                  <p><strong>Status:</strong> {selectedClaim.status}</p>
                  <p><strong>Receipt:</strong> {selectedClaim.receiptAvailable ? 'Available' : 'Missing'}</p>
                  <p><strong>Review confidence:</strong> {selectedClaim.aiReview?.confidence ?? 'Not reviewed yet'}</p>
                  <p><strong>Review method:</strong> {getReviewSourceLabel(selectedClaim.aiReview?.source)}</p>
                  <p><strong>Summary:</strong> {selectedClaim.aiReview?.summary || 'No review summary yet.'}</p>
                </div>
              </div>
              <div className="mt-5">
                <h4 className="mb-2 font-semibold">Deterministic findings</h4>
                <ul className="space-y-2 text-sm text-slate-600">
                  {(selectedClaim.deterministicFindings || []).map((finding, index) => (
                    <li key={index} className="rounded-xl border border-slate-200 p-3">
                      <p>{finding.message}</p>
                      {finding.policySectionIds.length > 0 && <p className="mt-1 text-xs">Policy: {finding.policySectionIds.join(', ')}</p>}
                      {finding.evidence && <p className="mt-1 text-xs text-slate-500">{finding.evidence}</p>}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-5">
                <h4 className="mb-2 font-semibold">Automated policy findings</h4>
                <p className="mb-2 text-sm text-slate-500">Review method: {getReviewSourceLabel(selectedClaim.aiReview?.source)}</p>
                <ul className="space-y-2 text-sm text-slate-600">
                  {(selectedClaim.aiReview?.findings || []).map((finding, index) => (
                    <li key={index} className="rounded-xl border border-slate-200 p-3">
                      <p>{finding.message}</p>
                      {finding.policySectionIds.length > 0 && <p className="mt-1 text-xs">Cited policy: {finding.policySectionIds.join(', ')}</p>}
                      {finding.evidence && <p className="mt-1 text-xs text-slate-500">{finding.evidence}</p>}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-5 flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Override category</span>
                  <select value={overrideCategory ?? selectedClaim.category} onChange={(event) => setOverrideCategory(event.target.value)} className="rounded-xl border border-slate-200 p-2">
                    {['Travel', 'Meals', 'Software', 'Office', 'Training', 'Mileage', 'Accommodation', 'Other'].map((category) => <option key={category}>{category}</option>)}
                  </select>
                </label>
                <button onClick={() => override(selectedClaim.id, overrideCategory ?? selectedClaim.category)} disabled={(overrideCategory ?? selectedClaim.category) === selectedClaim.category} className="rounded-xl border border-slate-200 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">Save classification override</button>
              </div>
              <div className="mt-5">
                <h4 className="mb-2 font-semibold">Audit / review history</h4>
                {(selectedClaim.reviewHistory || []).length === 0 ? (
                  <p className="text-sm text-slate-500">No review history recorded.</p>
                ) : (
                  <ol className="space-y-2 text-sm">
                    {(selectedClaim.reviewHistory || []).slice().reverse().map((entry, index) => (
                      <li key={`${entry.timestamp}-${index}`} className="rounded-xl border border-slate-200 p-3">
                        <p className="font-medium">{entry.action} · {entry.actor}</p>
                        <p className="text-slate-500">{entry.timestamp}{entry.reason ? ` · ${entry.reason}` : ''}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
