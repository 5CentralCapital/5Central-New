import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Search, Star } from 'lucide-react';
import { ReportCatalogSchema } from '@shared/report-catalog';
import type { CompanyContext } from '@shared/company/context';
import { reportingApi } from '../../reporting/api';
import { runtimeStatusLabel } from '../../reporting/workspace-model';
import { rentOpsAuthClient } from '../auth';
import { REPORT_KEYS, type ReportKey } from '../types';
import './report-library.css';

const groups = [
  ['financial', 'Financial'], ['rental', 'Rental'], ['tasks', 'Tasks'],
  ['projects', 'Projects'], ['investors', 'Investors'], ['forecast', 'Forecast'],
] as const;

export function ReportLibrary({ identity, organizationId, onCompanyChange, onOpen, onOpenCompany }: {
  identity: string; organizationId?: string; onCompanyChange?: (id: string) => void;
  onOpen: (key: ReportKey) => void; onOpenCompany?: (organizationId: string, reportId: string) => void;
}) {
  const context = useQuery({
    queryKey: ['rent-ops-workspace', 'company-context', identity],
    enabled: Boolean(onOpenCompany),
    queryFn: async ({ signal }): Promise<CompanyContext> => {
      const response = await rentOpsAuthClient.request('/api/company/context', { signal });
      if (!response.ok) throw new Error('Company reports could not be loaded.');
      return response.json();
    }, staleTime: 30_000, retry: false,
  });
  const organizations = context.data?.organizations ?? [];
  const organization = organizations.find(item => item.id === organizationId) ?? (!organizationId && organizations.length === 1 ? organizations[0] : undefined);
  const companyCatalog = useQuery({
    queryKey: ['company-reporting', 'catalog', identity, organization?.id], enabled: Boolean(organization && onOpenCompany),
    queryFn: ({ signal }) => reportingApi.catalog(organization!.id, signal), staleTime: 30_000, retry: false,
  });
  const companyEntries = new Map((companyCatalog.data ?? []).map(entry => [entry.id, entry]));
  const catalog = useQuery({
    queryKey: ['rent-ops-workspace', 'report-catalog', identity],
    queryFn: async ({ signal }) => {
      const response = await rentOpsAuthClient.request('/api/rent-ops/report-catalog', { signal });
      if (!response.ok) throw new Error('Reports could not be loaded.');
      return ReportCatalogSchema.parse(await response.json());
    }, staleTime: 300_000, retry: false,
  });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [view, setView] = useState('all');
  const favoriteKey = `rops:report-favorites:${identity}`;
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(favoriteKey) ?? '[]');
      return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string').slice(0, 100) : [];
    } catch { return []; }
  });
  const toggleFavorite = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter(value => value !== id) : [...favorites, id];
    setFavorites(next);
    try { localStorage.setItem(favoriteKey, JSON.stringify(next)); } catch { /* Available until this session ends. */ }
  };
  const query = search.trim().toLocaleLowerCase();
  const reports = catalog.data?.reports.filter(report =>
    (category === 'all' || report.category === category) &&
    (view === 'all' || view === 'available' && (report.availability === 'available' || companyEntries.get(report.id)?.executable) || view === 'favorites' && favorites.includes(report.id)) &&
    (!query || `${report.title} ${report.id}`.toLocaleLowerCase().includes(query)),
  );
  return <section className="rops-report-library" aria-label="Report library">
    {(organizations.length > 1 || organizationId && !organization) && <div className="rm-toolbar"><label>Company <select aria-label="Reporting company" value={organization?.id ?? ''} onChange={event => onCompanyChange?.(event.currentTarget.value)}><option value="" disabled>Select company</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>}
    <div className="rops-report-library-toolbar">
      <label className="rops-report-library-search"><Search size={17} aria-hidden="true"/><input aria-label="Search reports" placeholder="Search reports" value={search} onChange={event => setSearch(event.target.value)}/></label>
      <select aria-label="Report category" value={category} onChange={event => setCategory(event.target.value)}>
        <option value="all">All categories</option>{groups.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <select aria-label="Show reports" value={view} onChange={event => setView(event.target.value)}>
        <option value="all">All reports</option><option value="available">Available</option><option value="favorites">Favorites</option>
      </select>
    </div>
    {catalog.isPending && <div className="rm-empty" role="status">Loading reports…</div>}
    {catalog.error && <div className="rm-error" role="alert">Reports could not be loaded.<button className="rm-button" onClick={() => void catalog.refetch()}>Try again</button></div>}
    {(context.error || companyCatalog.error) && <div className="rm-error" role="alert">Company reports could not be loaded.<button className="rm-button" onClick={() => { void context.refetch(); void companyCatalog.refetch(); }}>Try again</button></div>}
    {catalog.data && reports?.length === 0 && <div className="rm-empty">No matching reports.</div>}
    {groups.map(([key, label]) => {
      const rows = reports?.filter(report => report.category === key);
      if (!rows?.length) return null;
      return <section className="rops-report-category" key={key} aria-label={`${label} reports`}>
        <h2>{label}</h2><ul>{rows.map(report => {
          const available = report.availability === 'available' && report.reportKey && REPORT_KEYS.includes(report.reportKey as ReportKey);
          const companyEntry = companyEntries.get(report.id);
          const companyAvailable = Boolean(organization && companyEntry && onOpenCompany);
          const isFavorite = favorites.includes(report.id);
          return <li key={report.id} data-report-id={report.id}>
            <button className="rops-report-favorite" type="button" aria-label={`${isFavorite ? 'Remove' : 'Add'} ${report.title} ${isFavorite ? 'from' : 'to'} favorites`} aria-pressed={isFavorite} onClick={() => toggleFavorite(report.id)}>
              <Star size={17} fill={isFavorite ? 'currentColor' : 'none'} aria-hidden="true"/>
            </button>
            <button className="rops-report-open" type="button" disabled={!available && !companyAvailable} onClick={() => { if (available) onOpen(report.reportKey as ReportKey); else if (companyAvailable) onOpenCompany?.(organization!.id, report.id); }}>
              <span>{report.title}</span>{available || companyEntry?.executable ? <ArrowUpRight size={16} aria-hidden="true"/> : <span className={`rops-report-availability is-${companyEntry?.runtimeStatus ?? 'unknown'}`} title={companyEntry?.runtimeReason ?? undefined}>{companyEntry ? runtimeStatusLabel(companyEntry.runtimeStatus) : companyCatalog.isFetching || context.isFetching ? 'Checking…' : 'Choose a company'}</span>}
              {!available && companyEntry && !companyEntry.executable && companyEntry.runtimeReason && <span className="rops-sr-only">{companyEntry.runtimeReason}</span>}
            </button>
          </li>;
        })}</ul>
      </section>;
    })}
  </section>;
}
