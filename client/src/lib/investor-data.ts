/* ══════════════════════════════════════════════════════════════
   INVESTOR & DEBT DATA — 5Central Capital
   General/blanket loans (monthly pmt) and mortgage obligations
   Used by Command Center for quick summary display.
   Full investor data lives in the database & Investor tab.
   ══════════════════════════════════════════════════════════════ */

export interface EquityInvestor {
  name: string;
  investedAmount: number;
  interestRate: number;
  monthlyPayment: number;
  payoffDate: string;
  annualInterest: number;
  status: "active" | "paid_off";
}

export interface MortgageObligation {
  property: string;
  lender: string;
  balance: number;
  interestRate: number;
  monthlyPI: number;
  maturityDate: string;
}

/* ── All Investors with Monthly Payments ── */
export const equityInvestors: EquityInvestor[] = [
  { name: "Pilar & Jozeph Bailon", investedAmount: 100_000, interestRate: 0.2183, monthlyPayment: 2_169.85, payoffDate: "TBD", annualInterest: 21_830, status: "active" },
  { name: "Pilar Bailon (Legacy)", investedAmount: 85_000, interestRate: 0.3142, monthlyPayment: 2_330.15, payoffDate: "Ongoing", annualInterest: 26_707, status: "active" },
  { name: "Teresa Bailon", investedAmount: 50_000, interestRate: 0.3916, monthlyPayment: 1_667.00, payoffDate: "Ongoing", annualInterest: 19_580, status: "active" },
  { name: "Vishwa Patel", investedAmount: 32_500, interestRate: 0, monthlyPayment: 1_046.79, payoffDate: "02/01/2028", annualInterest: 0, status: "active" },
  { name: "Coty Roberts", investedAmount: 50_000, interestRate: 0, monthlyPayment: 1_575.46, payoffDate: "02/01/2028", annualInterest: 0, status: "active" },
];

/* ── Mortgage / Senior Debt Obligations ── */
export const mortgageObligations: MortgageObligation[] = [
  // Sun Cove — Arcadia Vision Group (TODO: update from PDF)
  { property: "Sun Cove Apartments", lender: "Stormfield", balance: 2_100_000, interestRate: 0.1125, monthlyPI: 19_688, maturityDate: "2027-07-01" },
  // Lucia — Bridge loan: $925.5K acq + $219K rehab, 12 mo, 12% IO
  { property: "Lucia Apartments", lender: "Bridge Lender", balance: 1_144_500, interestRate: 0.12, monthlyPI: 11_445, maturityDate: "2027-02-28" },
  // Lucia — Seller note: $100K @ 12% IO, $1K/mo
  { property: "Lucia (Seller Note)", lender: "Seller", balance: 100_000, interestRate: 0.12, monthlyPI: 1_000, maturityDate: "TBD" },
  // Hickory Landing — Lakeland (TODO: update from PDF)
  { property: "Hickory Landing", lender: "Stormfield", balance: 730_000, interestRate: 0.1125, monthlyPI: 6_844, maturityDate: "2028-11-15" },
  // MLK — Refi: 30-yr fixed, 10-yr IO, 8.197%, closing Feb 2025
  { property: "MLK Apartments", lender: "Refi Lender", balance: 1_481_250, interestRate: 0.08197, monthlyPI: 10_118, maturityDate: "2055-02-25" },
];

/* ── Computed Totals ── */
export function getInvestorSummary() {
  const activeEquity = equityInvestors.filter(i => i.status === "active");
  const totalEquityInvested = activeEquity.reduce((s, i) => s + i.investedAmount, 0);
  const totalEquityMonthly = activeEquity.reduce((s, i) => s + i.monthlyPayment, 0);
  const totalAnnualInterest = activeEquity.reduce((s, i) => s + i.annualInterest, 0);
  const avgEquityRate = activeEquity.length > 0
    ? activeEquity.reduce((s, i) => s + i.interestRate * i.investedAmount, 0) / activeEquity.reduce((s, i) => s + i.investedAmount, 0)
    : 0;

  const totalMortgageBalance = mortgageObligations.reduce((s, m) => s + m.balance, 0);
  const totalMortgageMonthly = mortgageObligations.reduce((s, m) => s + m.monthlyPI, 0);

  const totalMonthlyObligations = totalEquityMonthly + totalMortgageMonthly;

  return {
    // General loans
    totalEquityInvested, totalEquityMonthly, totalAnnualInterest, avgEquityRate,
    activeEquityCount: activeEquity.length,
    // Mortgages
    totalMortgageBalance, totalMortgageMonthly,
    // Grand total
    totalMonthlyObligations,
  };
}
