import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart, Bar, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowRightLeft, BadgeCheck, BriefcaseBusiness, Building2, CheckCircle2, ClipboardList, Download, FileText, Layers3, Menu, ShieldCheck, Ticket, TrendingUp, UserRound, X } from 'lucide-react';
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  const loadData = async () => {
    setLoadError('');
    try {
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
    } catch {
      setLoadError('Could not load claims and policy data. Check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { void loadData(); }, []);

  const closeMobileNavigation = () => {
    setMobileNavOpen(false);
    menuButtonRef.current?.focus();
  };

  useEffect(() => {
    const sidebar = sidebarRef.current;
    const desktopMedia = window.matchMedia('(min-width: 768px)');
    const syncSidebarInert = () => {
      if (sidebar) sidebar.inert = !desktopMedia.matches && !mobileNavOpen;
      if (desktopMedia.matches && mobileNavOpen) setMobileNavOpen(false);
    };
    syncSidebarInert();
    desktopMedia.addEventListener('change', syncSidebarInert);

    if (!mobileNavOpen) {
      return () => {
        desktopMedia.removeEventListener('change', syncSidebarInert);
      };
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebar?.querySelector<HTMLElement>('button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMobileNavigation();
        return;
      }
      if (event.key !== 'Tab' || !sidebar) return;
      const focusable = Array.from(sidebar.querySelectorAll<HTMLElement>('button:not([disabled])'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      sidebar && (sidebar.inert = !desktopMedia.matches);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      desktopMedia.removeEventListener('change', syncSidebarInert);
    };
  }, [mobileNavOpen]);

  const showActionError = (error: unknown) => {
    setActionError(error instanceof Error ? error.message : 'The action could not be completed. Please try again.');
  };

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
    setIsSaving(true);
    setActionError('');
    const payload = {
      claimant: claimForm.claimant,
      expenseDate: claimForm.expenseDate,
      category: claimForm.category,
      amount: Number(claimForm.amount),
      currency: claimForm.currency,
      description: claimForm.description,
      receiptAvailable: claimForm.receiptAvailable,
    };
    try {
      await createClaim(payload);
      setClaimForm(defaultClaimForm);
      await loadData();
      setActiveTab('claims');
    } catch (error) {
      showActionError(error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreatePolicy = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    setActionError('');
    try {
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
    } catch (error) {
      showActionError(error);
    } finally {
      setIsSaving(false);
    }
  };

  const reviewClaim = async (claimId: string) => {
    setActionError('');
    try {
      const updated = await submitReview(claimId);
      setSelectedClaim(updated);
      await loadData();
    } catch (error) {
      showActionError(error);
    }
  };

  const performDecision = async (action: 'approve' | 'reject' | 'clarify', claimId: string, reason: string = 'Reviewed by finance operations.') => {
    setActionError('');
    try {
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
    } catch (error) {
      showActionError(error);
    }
  };

  const override = async (claimId: string, newCategory: string) => {
    setActionError('');
    try {
      const updated = await overrideClassification(claimId, newCategory, 'Reviewer changed the classification after checking policy context.');
      setSelectedClaim(updated);
      setOverrideCategory(null);
      await loadData();
    } catch (error) {
      showActionError(error);
    }
  };

  const renderDashboard = () => (
    <div className="min-w-0 space-y-5 sm:space-y-6">
      <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 xl:grid-cols-5 sm:gap-4">
        {[
          { label: 'Total Claims', value: metrics?.totalClaims || 0, icon: Ticket },
          { label: 'Pending', value: metrics?.pendingReviews || 0, icon: ClipboardList },
          { label: 'Approved', value: metrics?.approvedClaims || 0, icon: BadgeCheck },
          { label: 'Rejected', value: metrics?.rejectedClaims || 0, icon: Building2 },
          { label: 'Total Claimed', value: `$${(metrics?.totalClaimAmount || 0).toFixed(0)}`, icon: TrendingUp },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-soft sm:p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-500">{label}</p>
              <Icon className="h-5 w-5 text-accent" />
            </div>
            <h3 className="mt-3 break-words text-2xl font-semibold text-slate-900 sm:mt-4 sm:text-3xl">{value}</h3>
          </div>
        ))}
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-3 sm:gap-6">
        <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-soft sm:p-5 xl:col-span-2">
          <h3 className="mb-4 text-lg font-semibold">Recent claims</h3>
          <div className="space-y-3">
            {(claims || []).slice(0, 5).map((claim) => (
              <div key={claim.id} className="flex min-w-0 flex-col gap-2 rounded-xl border border-slate-200 p-3 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{claim.id}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{claim.category}</span>
                  </div>
                  <p className="break-words text-sm text-slate-500">{claim.claimant}</p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 min-[420px]:flex-col min-[420px]:items-end min-[420px]:text-right">
                  <p className="font-medium">{claim.currency} {claim.amount}</p>
                  <span className="inline-flex rounded-full px-2 py-1 text-xs font-medium" style={{ backgroundColor: `${statusColors[claim.status] || '#e2e8f0'}22`, color: statusColors[claim.status] || '#334155' }}>{claim.status}</span>
                </div>
              </div>
            ))}
            {claims.length === 0 && <p className="text-sm text-slate-500">No claims to display yet.</p>}
          </div>
        </div>

        <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-soft sm:p-5">
          <h3 className="mb-4 text-lg font-semibold">Status distribution</h3>
          <div className="h-52 min-w-0">
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

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft sm:p-5">
        <h3 className="mb-4 text-lg font-semibold">Recent reviewer activity</h3>
        <div className="space-y-3">
          {(claims || []).slice(0, 4).map((claim) => (
            <div key={`activity-${claim.id}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-slate-100 py-2 last:border-b-0">
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
    <div className="min-w-0 space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:flex xl:items-center xl:justify-between">
        <label className="sr-only" htmlFor="claim-search">Search claims</label>
        <input id="claim-search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 p-3 xl:max-w-xs" placeholder="Search claims" />
        <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
          <label className="sr-only" htmlFor="claim-status-filter">Filter claims by status</label>
          <select id="claim-status-filter" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 p-3">
            <option value="all">All statuses</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="pending_review">Pending review</option>
            <option value="clarification_required">Clarification required</option>
          </select>
          <label className="sr-only" htmlFor="claim-category-filter">Filter claims by category</label>
          <select id="claim-category-filter" value={categoryFilter} onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 p-3">
            <option value="all">All categories</option>
            {['Travel', 'Meals', 'Software', 'Office', 'Training', 'Mileage', 'Accommodation', 'Other'].map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        </div>
      </div>

      <div className="hidden overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-soft md:block">
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
      <div className="grid grid-cols-1 gap-3 md:hidden">
        {pagedClaims.map((claim) => (
          <article key={claim.id} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="break-words font-semibold">{claim.id}</h3>
                <p className="break-words text-sm text-slate-600">{claim.claimant}</p>
              </div>
              <span className="max-w-full break-words rounded-full px-2 py-1 text-xs font-medium" style={{ backgroundColor: `${statusColors[claim.status] || '#e2e8f0'}22`, color: statusColors[claim.status] || '#334155' }}>{claim.status.replaceAll('_', ' ')}</span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <div><dt className="text-slate-500">Submitted</dt><dd>{claim.expenseDate}</dd></div>
              <div><dt className="text-slate-500">Category</dt><dd className="break-words">{claim.category}</dd></div>
              <div><dt className="text-slate-500">Amount</dt><dd>{claim.currency} {claim.amount}</dd></div>
              <div><dt className="text-slate-500">Receipt</dt><dd>{claim.receiptAvailable ? 'Yes' : 'No'}</dd></div>
              <div className="col-span-2"><dt className="text-slate-500">Policy review</dt><dd className="break-words">{claim.aiReview?.reviewStatus || claim.status} · {getReviewSourceLabel(claim.aiReview?.source, 'Pending')}</dd></div>
            </dl>
            <button onClick={() => setSelectedClaim(claim)} className="mt-3 min-h-11 w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white">View claim details</button>
          </article>
        ))}
        {pagedClaims.length === 0 && <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">No claims match your search and filters.</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="min-h-11 rounded-xl border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50">Previous</button>
        <span className="self-center">Page {page} of {totalPages}</span>
        <button disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className="min-h-11 rounded-xl border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50">Next</button>
      </div>
    </div>
  );

  const renderSubmit = () => (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft sm:p-6">
      <h3 className="mb-5 text-xl font-semibold">Submit an expense claim</h3>
      <form onSubmit={handleSubmitClaim} className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
        <label className="block min-w-0"><span className="mb-1 block text-sm font-medium">Claimant name</span><input required autoComplete="name" value={claimForm.claimant} onChange={(e) => setClaimForm({ ...claimForm, claimant: e.target.value })} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 p-3" /></label>
        <label className="block min-w-0"><span className="mb-1 block text-sm font-medium">Expense date</span><input required type="date" value={claimForm.expenseDate} onChange={(e) => setClaimForm({ ...claimForm, expenseDate: e.target.value })} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 p-3" /></label>
        <label className="block min-w-0"><span className="mb-1 block text-sm font-medium">Category</span><select value={claimForm.category} onChange={(e) => setClaimForm({ ...claimForm, category: e.target.value })} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 p-3"><option>Travel</option><option>Meals</option><option>Software</option><option>Office</option><option>Training</option><option>Mileage</option><option>Accommodation</option><option>Other</option></select></label>
        <label className="block min-w-0"><span className="mb-1 block text-sm font-medium">Currency</span><select value={claimForm.currency} onChange={(e) => setClaimForm({ ...claimForm, currency: e.target.value })} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 p-3"><option>USD</option><option>EUR</option><option>GBP</option><option>AUD</option><option>CAD</option><option>JPY</option></select></label>
        <label className="block min-w-0"><span className="mb-1 block text-sm font-medium">Amount</span><input required min="0.01" step="0.01" type="number" inputMode="decimal" value={claimForm.amount} onChange={(e) => setClaimForm({ ...claimForm, amount: e.target.value })} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 p-3" /></label>
        <label className="block min-w-0"><span className="mb-1 block text-sm font-medium">Receipt available</span><select value={String(claimForm.receiptAvailable)} onChange={(e) => setClaimForm({ ...claimForm, receiptAvailable: e.target.value === 'true' })} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 p-3"><option value="true">Yes</option><option value="false">No</option></select></label>
        <label className="block min-w-0 md:col-span-2"><span className="mb-1 block text-sm font-medium">Description</span><textarea required minLength={3} value={claimForm.description} onChange={(e) => setClaimForm({ ...claimForm, description: e.target.value })} className="min-h-28 w-full min-w-0 rounded-xl border border-slate-200 p-3" /></label>
        <div className="md:col-span-2"><button disabled={isSaving} type="submit" className="min-h-11 w-full rounded-xl bg-accent px-5 py-3 font-medium text-white disabled:opacity-60 sm:ml-auto sm:w-auto">Submit claim</button></div>
      </form>
    </div>
  );

  const renderPolicies = () => (
    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2 sm:gap-6">
      <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-soft sm:p-5">
        <h3 className="mb-4 text-xl font-semibold">Policy sections</h3>
        <div className="space-y-3">
          {policies.map((policy) => (
            <div key={policy.id} className="min-w-0 rounded-xl border border-slate-200 p-3">
            <div className="flex flex-wrap justify-between gap-2"><span className="break-all font-medium">{policy.id}</span><span className="rounded-full bg-slate-100 px-2 py-1 text-xs">{policy.status}</span></div>
            <p className="mt-2 break-words text-sm text-slate-700">{policy.title}</p>
            <p className="mt-2 break-words text-sm text-slate-600">{policy.summary}</p>
            </div>
          ))}
          {policies.length === 0 && <p className="text-sm text-slate-500">No policy sections are available.</p>}
        </div>
      </div>
      <form onSubmit={handleCreatePolicy} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-soft sm:p-5">
        <h3 className="mb-4 text-xl font-semibold">Add policy section</h3>
        <div className="space-y-3">
          <label className="block"><span className="mb-1 block text-sm font-medium">Title</span><input required minLength={2} value={policyForm.title} onChange={(e) => setPolicyForm({ ...policyForm, title: e.target.value })} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 p-3" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium">Summary</span><input required minLength={2} value={policyForm.summary} onChange={(e) => setPolicyForm({ ...policyForm, summary: e.target.value })} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 p-3" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium">Policy text</span><textarea required minLength={20} value={policyForm.policyText} onChange={(e) => setPolicyForm({ ...policyForm, policyText: e.target.value })} className="min-h-28 w-full min-w-0 rounded-xl border border-slate-200 p-3" /></label>
          <label className="block"><span className="mb-1 block text-sm font-medium">Categories (comma separated)</span><input required value={policyForm.categories} onChange={(e) => setPolicyForm({ ...policyForm, categories: e.target.value })} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 p-3" /></label>
          <label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-blue-600" checked={policyForm.receiptRequired} onChange={(e) => setPolicyForm({ ...policyForm, receiptRequired: e.target.checked })} /> Requires receipt</label>
          <label className="block"><span className="mb-1 block text-sm font-medium">Effective date</span><input required type="date" value={policyForm.effectiveDate} onChange={(e) => setPolicyForm({ ...policyForm, effectiveDate: e.target.value })} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-200 p-3" /></label>
          <button disabled={isSaving} type="submit" className="min-h-11 w-full rounded-xl bg-accent px-4 py-3 font-medium text-white disabled:opacity-60">Save policy</button>
        </div>
      </form>
    </div>
  );

  const renderQueue = () => (
    <div className="space-y-4">
      {claims.filter((claim) => ['pending_review', 'clarification_required', 'needs_attention', 'missing_receipt'].includes(claim.status)).map((claim) => (
        <div key={claim.id} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-soft sm:p-5">
          <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="break-words text-lg font-semibold">{claim.id}</h3>
                <span className="max-w-full break-words rounded-full px-2 py-1 text-xs font-medium" style={{ backgroundColor: `${statusColors[claim.status] || '#e2e8f0'}22`, color: statusColors[claim.status] || '#334155' }}>{claim.status.replaceAll('_', ' ')}</span>
              </div>
              <p className="mt-1 break-words text-sm text-slate-600">{claim.claimant} · {claim.category} · {claim.currency} {claim.amount}</p>
            </div>
            <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 lg:flex lg:flex-wrap lg:justify-end">
              <button onClick={() => reviewClaim(claim.id)} className="min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm">Review</button>
              <button onClick={() => performDecision('clarify', claim.id, 'Please provide additional information for this claim.')} className="min-h-11 rounded-xl border border-amber-300 px-3 py-2 text-sm text-amber-900">Request clarification</button>
              <button onClick={() => performDecision('approve', claim.id)} className="min-h-11 rounded-xl bg-success px-3 py-2 text-sm text-white">Approve</button>
              <button onClick={() => performDecision('reject', claim.id, 'Policy violation identified.')} className="min-h-11 rounded-xl bg-danger px-3 py-2 text-sm text-white">Reject</button>
            </div>
          </div>
        </div>
      ))}
      {claims.filter((claim) => ['pending_review', 'clarification_required', 'needs_attention', 'missing_receipt'].includes(claim.status)).length === 0 && (
        <p className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-600">The review queue is clear.</p>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="Close navigation menu"
          className="fixed inset-0 z-40 bg-slate-950/60 md:hidden"
          onClick={closeMobileNavigation}
        />
      )}
      <div className="flex min-h-screen min-w-0">
        <aside
          ref={sidebarRef}
          id="primary-navigation"
          aria-label="Primary navigation"
          role={mobileNavOpen ? 'dialog' : undefined}
          aria-modal={mobileNavOpen || undefined}
          className={`fixed inset-y-0 left-0 z-50 w-[min(18rem,85vw)] overflow-y-auto bg-navy p-5 text-white transition-transform duration-200 ease-out motion-reduce:transition-none md:static md:z-auto md:w-64 md:shrink-0 md:translate-x-0 ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full'}`}
        >
          <div className="mb-8 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
            <div className="rounded-xl bg-white/10 p-2"><BriefcaseBusiness className="h-5 w-5" /></div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-300">Finance Ops</p>
              <h1 className="text-lg font-semibold">Expense Review</h1>
            </div>
            </div>
            <button
              type="button"
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-200 hover:bg-white/10 focus-visible:outline-white md:hidden"
              aria-label="Close navigation menu"
              onClick={closeMobileNavigation}
            >
              <X aria-hidden="true" className="h-5 w-5" />
            </button>
          </div>
          <nav className="space-y-2">
            {navItems.map(({ key, label, icon: Icon }) => (
              <button key={key} aria-current={activeTab === key ? 'page' : undefined} onClick={() => { setActiveTab(key); if (mobileNavOpen) closeMobileNavigation(); }} className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-3 text-left ${activeTab === key ? 'bg-white/10' : 'text-slate-200 hover:bg-white/5'}`}>
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <main aria-hidden={mobileNavOpen} className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          <div className="mb-5 flex min-w-0 flex-wrap items-center justify-between gap-3 sm:mb-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                ref={menuButtonRef}
                type="button"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-soft md:hidden"
                aria-label="Open navigation menu"
                aria-expanded={mobileNavOpen}
                aria-controls="primary-navigation"
                onClick={() => setMobileNavOpen(true)}
              >
                <Menu aria-hidden="true" className="h-5 w-5" />
              </button>
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-600 sm:text-sm sm:tracking-[0.2em]">Policy review assistant</p>
                <h2 className="break-words text-[clamp(1.35rem,4vw,1.875rem)] font-semibold">{navItems.find((item) => item.key === activeTab)?.label}</h2>
              </div>
            </div>
            <div className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-soft sm:px-4">
              <UserRound className="h-4 w-4 text-slate-500" />
              <span className="text-xs sm:text-sm">Finance reviewer</span>
            </div>
          </div>
          {loadError && (
            <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              <span>{loadError}</span>
              <button type="button" onClick={() => { setIsLoading(true); void loadData(); }} className="min-h-11 rounded-lg border border-red-300 px-3 font-medium">Retry</button>
            </div>
          )}
          {actionError && (
            <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              <span>{actionError}</span>
              <button type="button" aria-label="Dismiss error" onClick={() => setActionError('')} className="min-h-11 rounded-lg px-3 underline">Dismiss</button>
            </div>
          )}
          {isLoading ? (
            <p role="status" className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-600">Loading claims and policies…</p>
          ) : loadError ? null : (
            <>
              {activeTab === 'dashboard' && renderDashboard()}
              {activeTab === 'claims' && renderClaims()}
              {activeTab === 'submit' && renderSubmit()}
              {activeTab === 'queue' && renderQueue()}
              {activeTab === 'policies' && renderPolicies()}
            </>
          )}

          {!isLoading && !loadError && selectedClaim && (
            <div className="mt-6 min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-soft sm:mt-8 sm:p-5">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Claim details</p>
                  <h3 className="text-xl font-semibold">{selectedClaim.id}</h3>
                </div>
                <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:flex sm:flex-wrap">
                  <button onClick={() => reviewClaim(selectedClaim.id)} className="min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm">Run policy review</button>
                  <button onClick={() => performDecision('approve', selectedClaim.id)} className="min-h-11 rounded-xl bg-success px-3 py-2 text-sm text-white">Approve</button>
                  <button onClick={() => performDecision('reject', selectedClaim.id, 'Reason for rejection')} className="min-h-11 rounded-xl bg-danger px-3 py-2 text-sm text-white">Reject</button>
                </div>
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
                <div className="min-w-0 space-y-2 break-words">
                  <p><strong>Claimant:</strong> {selectedClaim.claimant}</p>
                  <p><strong>Category:</strong> {selectedClaim.category}</p>
                  <p><strong>Date:</strong> {selectedClaim.expenseDate}</p>
                  <p><strong>Amount:</strong> {selectedClaim.currency} {selectedClaim.amount}</p>
                </div>
                <div className="min-w-0 space-y-2 break-words">
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
              <div className="mt-5 grid grid-cols-1 items-end gap-3 min-[480px]:grid-cols-[minmax(0,1fr)_auto]">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Override category</span>
                  <select value={overrideCategory ?? selectedClaim.category} onChange={(event) => setOverrideCategory(event.target.value)} className="min-h-11 w-full rounded-xl border border-slate-200 p-2">
                    {['Travel', 'Meals', 'Software', 'Office', 'Training', 'Mileage', 'Accommodation', 'Other'].map((category) => <option key={category}>{category}</option>)}
                  </select>
                </label>
                <button onClick={() => override(selectedClaim.id, overrideCategory ?? selectedClaim.category)} disabled={(overrideCategory ?? selectedClaim.category) === selectedClaim.category} className="min-h-11 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50 min-[480px]:w-auto">Save classification override</button>
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
