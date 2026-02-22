export type Status = "open" | "in_progress" | "done" | "blocked";
export type OccupancyStatus = "stable" | "watch" | "critical";
export type RehabStatus = "not_started" | "in_progress" | "complete" | "blocked";
export type DebtUrgency = "urgent" | "upcoming" | "safe";
export type PropertyPhase = "stabilizing" | "rehab" | "stabilized" | "lease_up" | "sold";

export interface TaskItem {
  id: string;
  title: string;
  dueDate?: string;
  cadence?: "daily" | "weekly" | "monthly" | "quarterly" | "ad_hoc";
  status: Status;
  property: string;
  module: "reminders" | "long_term" | "future_plans" | "ideas_backlog" | "rehab";
  notes?: string;
  priority?: "low" | "medium" | "high" | "critical";
}

export interface PortfolioMetric {
  id: string;
  label: string;
  value: number;
  unit?: string;
  trend?: number;
  target?: number;
  format?: "currency" | "percent" | "number" | "multiplier";
}

export interface PropertyCard {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  units: number;
  acquisitionPrice: number;
  rehabBudget: number;
  totalBasis: number;
  currentValue: number;
  currentDebt: number;
  currentEquity: number;
  lender: string;
  interestRate: number;
  maturityDate: string;
  annualNOI: number;
  yieldOnCost: number;
  capRate: number;
  dscr: number;
  occupancyRate: number;
  occupiedUnits: number;
  phase: PropertyPhase;
  refiTarget: string;
  refiProceeds?: number;
}

export interface RehabTracker {
  id: string;
  property: string;
  project: string;
  budget: number;
  spent: number;
  completionPct: number;
  status: RehabStatus;
  targetDate?: string;
  notes?: string;
}

export interface OccupancyRecord {
  id: string;
  property: string;
  units: number;
  occupied: number;
  vacant: number;
  occupancyRate: number;
  monthlyRent: number;
  status: OccupancyStatus;
}

export interface KPIRecord {
  id: string;
  name: string;
  current: number;
  previous: number;
  target: number;
  unit?: string;
  format?: "currency" | "percent" | "number" | "multiplier";
  property?: string;
  date: string;
}

export interface DebtMaturity {
  id: string;
  property: string;
  lender: string;
  balance: number;
  interestRate: number;
  maturityDate: string;
  daysUntilMaturity: number;
  urgency: DebtUrgency;
  refiTarget: string;
  expectedProceeds: number;
}

export interface GrowthMilestone {
  id: string;
  year: number;
  targetUnits: number;
  targetAUM: number;
  targetEquity: number;
  phase: string;
  status: "completed" | "current" | "planned";
}

export interface ActivityLog {
  id: string;
  ts: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  detail: string;
}

export interface SourceStatus {
  source: "xlsx" | "github";
  lastSuccessAt?: string;
  lastError?: string;
  rowCount: number;
}

/* ── Banking / Plaid ── */

export interface BankAccount {
  id: string;
  plaidAccountId: string;
  name: string;
  officialName?: string;
  type: string;           // depository, credit, loan, investment
  subtype: string;        // checking, savings, credit card, etc.
  mask?: string;          // last 4 digits
  currentBalance: number;
  availableBalance?: number;
  currency: string;
  institution?: string;
  lastSynced?: string;
}

export interface BankTransaction {
  id: string;
  accountId: string;
  date: string;
  name: string;
  amount: number;         // positive = debit, negative = credit in Plaid
  category?: string[];
  merchantName?: string;
  pending: boolean;
}

export interface PlaidConnection {
  id: string;
  institutionName: string;
  institutionId?: string;
  status: "active" | "error" | "pending";
  lastSynced?: string;
  accountCount: number;
  error?: string;
}

export interface DashboardData {
  tasks: TaskItem[];
  metrics: PortfolioMetric[];
  properties: PropertyCard[];
  rehab: RehabTracker[];
  occupancy: OccupancyRecord[];
  kpis: KPIRecord[];
  debt: DebtMaturity[];
  growth: GrowthMilestone[];
  activity: ActivityLog[];
  freshness?: { label: string; at: string; source: string }[];
  diagnostics?: SourceStatus[];
  banking?: {
    accounts: BankAccount[];
    recentTransactions: BankTransaction[];
    connections: PlaidConnection[];
    totalCash: number;
  };
}
