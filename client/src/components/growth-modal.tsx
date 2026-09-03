import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Building2,
  TrendingUp,
  Target,
  Calendar,
  DollarSign,
  Percent,
  ArrowRight,
  Award
} from "lucide-react";
import { publicCurrentProperties, publicPortfolioFacts } from "@/lib/public-portfolio-data";

interface GrowthModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'current' | 'future';
}

const compactMoney = (value: number) =>
  value >= 1_000_000 ? `$${(value / 1_000_000).toFixed(2)}M` : `$${(value / 1_000).toFixed(1)}K`;

const exactMoney = (value: number) => {
  const hasCents = Math.abs(value - Math.round(value)) > 0.001;
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
};

// Current property totals use the same public underwriting object as the portfolio page.
const currentData = {
  totalUnits: publicPortfolioFacts.activeMultifamilyUnits,
  aum: publicPortfolioFacts.publicAum / 1_000_000,
  annualNOI: publicPortfolioFacts.underwrittenNOI / 1_000,
  yieldOnCost: publicPortfolioFacts.yieldOnCost * 100,
  portfolioLTV: publicPortfolioFacts.currentMortgageDebt / publicPortfolioFacts.publicAum * 100,
  totalEquity: publicPortfolioFacts.portfolioEquity / 1_000_000,
  properties: publicCurrentProperties.map((property) => ({
    name: property.name.replace(" Apartments", ""),
    units: property.units,
    noi: exactMoney(parseFloat(property.noi || "0")),
    status: property.phase === "lease_up" ? "Lease-up" : "Stabilizing",
  })),
  keyMetrics: [
    { label: 'Portfolio Occupancy', value: `${(publicPortfolioFacts.currentOccupancy * 100).toFixed(1)}%`, icon: Building2 },
    { label: 'Contracted Base Rent', value: `${compactMoney(publicPortfolioFacts.inPlaceMonthlyRent)}/mo`, icon: DollarSign },
    { label: 'Underwritten Rent', value: `${compactMoney(publicPortfolioFacts.proformaMonthlyRent)}/mo`, icon: TrendingUp },
    { label: 'Weighted Cap Rate', value: `${(publicPortfolioFacts.weightedCapRate * 100).toFixed(1)}%`, icon: Percent },
  ]
};

// Future Projections Data
const futureData = {
  targetUnits: 124,
  targetAUM: 23.76,
  projectedNOI: 1500,
  unitsGrowth: '+125%',
  equityGrowth: '+200%',
  milestones: [
    {
      date: 'Jun 2026',
      title: 'Rehab Completion',
      description: 'Sun Cove & Lucia stabilize to 95% occupancy',
      units: 37,
      status: 'In Progress'
    },
    {
      date: 'Aug 2026',
      title: 'Strategic Refinancing',
      description: 'Lucia & Sun Cove refinance releasing $843K equity',
      proceeds: '$843K',
      status: 'Planned'
    },
    {
      date: 'Aug 2026',
      title: 'Acquisition #1',
      description: '40-unit property acquisition using refinance proceeds',
      units: 40,
      capital: '$1.28M',
      status: 'Target'
    },
    {
      date: 'Nov 2026',
      title: 'Acquisition #2',
      description: '40-unit property to reach year-end target',
      units: 40,
      capital: '$1.28M',
      status: 'Target'
    },
  ],
  projections: [
    { label: 'Target Portfolio Size', value: '124 Units' },
    { label: 'Projected AUM', value: '$23.76M' },
    { label: 'Est. Annual NOI', value: '$1.5M' },
    { label: 'Target Avg Yield', value: '9.5%' },
  ]
};

export default function GrowthModal({ isOpen, onClose, type }: GrowthModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto p-0">
        {type === 'current' ? (
          <CurrentPortfolioView />
        ) : (
          <FutureVisionView />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CurrentPortfolioView() {
  return (
    <>
      <DialogHeader className="p-8 pb-6 bg-gradient-to-b from-soft-cream to-background border-b border-border/50">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-full bg-warm-brass/10 border border-warm-brass/20 flex items-center justify-center">
            <Target className="w-5 h-5 text-warm-brass" />
          </div>
          <div>
            <span className="text-[10px] uppercase tracking-[0.3em] text-warm-brass font-medium">
              Current State
            </span>
            <DialogTitle className="text-2xl font-serif font-medium text-foreground">
              Current Portfolio
            </DialogTitle>
            <DialogDescription className="sr-only">
              Current property-level portfolio totals and underwriting metrics.
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="p-8 space-y-8">
        {/* Hero Stats */}
        <div className="grid grid-cols-3 gap-6">
          <div className="text-center p-6 bg-white border border-border rounded-lg">
            <div className="font-serif text-5xl font-light text-foreground mb-2">
              {currentData.totalUnits}
            </div>
            <div className="text-sm uppercase tracking-wider text-muted-foreground">Total Units</div>
          </div>
          <div className="text-center p-6 bg-white border border-border rounded-lg">
            <div className="font-serif text-5xl font-light text-warm-brass mb-2">
              ${currentData.aum.toFixed(2)}M
            </div>
            <div className="text-sm uppercase tracking-wider text-muted-foreground">Assets Under Management</div>
          </div>
          <div className="text-center p-6 bg-white border border-border rounded-lg">
            <div className="font-serif text-5xl font-light text-foreground mb-2">
              ${currentData.annualNOI.toFixed(1)}K
            </div>
            <div className="text-sm uppercase tracking-wider text-muted-foreground">Annual NOI</div>
          </div>
        </div>

        {/* Key Metrics */}
        <div className="grid grid-cols-4 gap-4">
          {currentData.keyMetrics.map((metric, i) => (
            <div key={i} className="p-4 bg-soft-cream rounded-lg">
              <metric.icon className="w-5 h-5 text-warm-brass mb-3" />
              <div className="font-serif text-2xl text-foreground mb-1">{metric.value}</div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">{metric.label}</div>
            </div>
          ))}
        </div>

        {/* Properties Table */}
        <div>
          <h3 className="text-lg font-serif font-medium text-foreground mb-4 flex items-center gap-2">
            <Building2 className="w-5 h-5 text-warm-brass" />
            Active Properties
          </h3>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-soft-cream">
                <tr>
                  <th className="text-left px-4 py-3 text-xs uppercase tracking-wider text-muted-foreground font-medium">Property</th>
                  <th className="text-center px-4 py-3 text-xs uppercase tracking-wider text-muted-foreground font-medium">Units</th>
                  <th className="text-center px-4 py-3 text-xs uppercase tracking-wider text-muted-foreground font-medium">Underwritten NOI</th>
                  <th className="text-right px-4 py-3 text-xs uppercase tracking-wider text-muted-foreground font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {currentData.properties.map((prop, i) => (
                  <tr key={i} className="hover:bg-soft-cream/50 transition-colors">
                    <td className="px-4 py-4 font-medium text-foreground">{prop.name}</td>
                    <td className="px-4 py-4 text-center text-muted-foreground">{prop.units}</td>
                    <td className="px-4 py-4 text-center font-medium text-warm-brass">{prop.noi}</td>
                    <td className="px-4 py-4 text-right">
                      <span className={`inline-flex px-2 py-1 text-xs rounded-full ${
                        prop.status === 'Stabilized'
                          ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                          : 'bg-amber-50 text-amber-600 border border-amber-200'
                      }`}>
                        {prop.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Portfolio Metrics Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-border">
          <div className="p-4 border-l-2 border-warm-brass/30">
            <div className="font-serif text-xl text-foreground mb-1">{currentData.yieldOnCost.toFixed(1)}%</div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Yield on Cost</div>
          </div>
          <div className="p-4 border-l-2 border-warm-brass/30">
            <div className="font-serif text-xl text-foreground mb-1">{currentData.portfolioLTV.toFixed(1)}%</div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Portfolio LTV</div>
          </div>
          <div className="p-4 border-l-2 border-warm-brass/30">
            <div className="font-serif text-xl text-foreground mb-1">${currentData.totalEquity.toFixed(2)}M</div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Total Equity</div>
          </div>
          <div className="p-4 border-l-2 border-warm-brass/30">
            <div className="font-serif text-xl text-foreground mb-1">4</div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Active Properties</div>
          </div>
        </div>
      </div>
    </>
  );
}

function FutureVisionView() {
  return (
    <>
      <DialogHeader className="p-8 pb-6 bg-deep-charcoal text-white relative overflow-hidden">
        {/* Subtle texture */}
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        }} />
        {/* Gold accent line */}
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-warm-brass to-transparent" />

        <div className="relative flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-full bg-warm-brass/20 border border-warm-brass/30 flex items-center justify-center">
            <TrendingUp className="w-5 h-5 text-warm-brass" />
          </div>
          <div>
            <span className="text-[10px] uppercase tracking-[0.3em] text-warm-brass font-medium">
              Year-End 2026
            </span>
            <DialogTitle className="text-2xl font-serif font-medium text-white">
              Growth Roadmap
            </DialogTitle>
            <DialogDescription className="sr-only">
              Future portfolio targets and planned growth milestones.
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="p-8 space-y-8">
        {/* Hero Stats with Growth */}
        <div className="grid grid-cols-2 gap-6">
          <div className="p-6 bg-soft-cream rounded-lg relative overflow-hidden">
            <div className="absolute top-2 right-2 px-2 py-1 bg-emerald-100 text-emerald-600 text-xs font-medium rounded-full">
              {futureData.unitsGrowth}
            </div>
            <div className="font-serif text-6xl font-light text-foreground mb-2">
              {futureData.targetUnits}
            </div>
            <div className="text-sm uppercase tracking-wider text-muted-foreground">Target Units</div>
            <div className="flex items-center gap-2 mt-3 text-sm text-muted-foreground">
              <span>55 units</span>
              <ArrowRight className="w-4 h-4 text-warm-brass" />
              <span className="text-warm-brass font-medium">{futureData.targetUnits} units</span>
            </div>
          </div>
          <div className="p-6 bg-deep-charcoal text-white rounded-lg relative overflow-hidden">
            <div className="absolute top-2 right-2 px-2 py-1 bg-warm-brass/20 text-warm-brass text-xs font-medium rounded-full border border-warm-brass/30">
              {futureData.equityGrowth}
            </div>
            <div className="font-serif text-6xl font-light mb-2">
              ${futureData.targetAUM}M
            </div>
            <div className="text-sm uppercase tracking-wider text-white/50">Target AUM</div>
            <div className="flex items-center gap-2 mt-3 text-sm text-white/50">
              <span>{publicPortfolioFacts.publicAumLabel}</span>
              <ArrowRight className="w-4 h-4 text-warm-brass" />
              <span className="text-warm-brass font-medium">${futureData.targetAUM}M</span>
            </div>
          </div>
        </div>

        {/* Milestones Timeline */}
        <div>
          <h3 className="text-lg font-serif font-medium text-foreground mb-6 flex items-center gap-2">
            <Calendar className="w-5 h-5 text-warm-brass" />
            2026 Milestones
          </h3>
          <div className="relative space-y-4">
            {/* Timeline line */}
            <div className="absolute left-[59px] top-4 bottom-4 w-px bg-gradient-to-b from-warm-brass via-warm-brass/50 to-warm-brass/20" />

            {futureData.milestones.map((milestone, i) => (
              <div key={i} className="flex gap-4 relative">
                {/* Date */}
                <div className="w-16 text-right flex-shrink-0 pt-4">
                  <span className="text-sm font-medium text-warm-brass">{milestone.date.split(' ')[0]}</span>
                </div>

                {/* Dot */}
                <div className="flex-shrink-0 pt-4 relative z-10">
                  <div className={`w-3 h-3 rounded-full border-2 ${
                    milestone.status === 'In Progress'
                      ? 'bg-warm-brass border-warm-brass shadow-[0_0_8px_rgba(196,165,116,0.5)]'
                      : 'bg-white border-warm-brass/50'
                  }`} />
                </div>

                {/* Card */}
                <div className={`flex-1 p-5 rounded-lg border transition-all ${
                  milestone.status === 'In Progress'
                    ? 'bg-warm-brass/5 border-warm-brass/30'
                    : 'bg-white border-border hover:border-warm-brass/30 hover:shadow-md'
                }`}>
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h4 className="font-serif text-lg font-medium text-foreground">{milestone.title}</h4>
                      <p className="text-sm text-muted-foreground mt-1">{milestone.description}</p>
                    </div>
                    <span className={`px-2 py-1 text-xs rounded-full ${
                      milestone.status === 'In Progress'
                        ? 'bg-warm-brass/20 text-warm-brass'
                        : milestone.status === 'Planned'
                        ? 'bg-blue-50 text-blue-600 border border-blue-200'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {milestone.status}
                    </span>
                  </div>
                  <div className="flex gap-4 mt-3">
                    {milestone.units && (
                      <div className="flex items-center gap-1 text-sm">
                        <Building2 className="w-4 h-4 text-muted-foreground" />
                        <span className="text-foreground font-medium">{milestone.units} units</span>
                      </div>
                    )}
                    {milestone.proceeds && (
                      <div className="flex items-center gap-1 text-sm">
                        <DollarSign className="w-4 h-4 text-muted-foreground" />
                        <span className="text-emerald-600 font-medium">{milestone.proceeds}</span>
                      </div>
                    )}
                    {milestone.capital && (
                      <div className="flex items-center gap-1 text-sm">
                        <DollarSign className="w-4 h-4 text-muted-foreground" />
                        <span className="text-foreground font-medium">{milestone.capital} capital</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Year-End Projections */}
        <div className="p-6 bg-deep-charcoal text-white rounded-lg relative overflow-hidden">
          <div className="absolute inset-0 opacity-[0.03]" style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          }} />
          <div className="relative">
            <div className="flex items-center gap-2 mb-4">
              <Award className="w-5 h-5 text-warm-brass" />
              <h4 className="font-serif text-lg font-medium">Year-End 2026 Targets</h4>
            </div>
            <div className="grid grid-cols-4 gap-4">
              {futureData.projections.map((proj, i) => (
                <div key={i} className="p-4 bg-white/5 border border-white/10 rounded-lg">
                  <div className="font-serif text-2xl text-warm-brass mb-1">{proj.value}</div>
                  <div className="text-xs uppercase tracking-wider text-white/40">{proj.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
