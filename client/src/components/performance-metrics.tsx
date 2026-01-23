import { useInViewCounter } from "@/hooks/use-animated-counter";
import { TrendingUp, Building2, DollarSign, BarChart3, MapPin } from "lucide-react";

interface PerformanceMetricsProps {
  totalPortfolioValue: number;
  totalUnits: number;
  totalEquityCreated: number;
  avgReturn: number;
  currentProperties: number;
  soldProperties: number;
  avgEquityMultiple: number;
  totalRealizedProfits: number;
  ctUnits?: number;
  flUnits?: number;
}

function MetricCard({
  value,
  label,
  sublabel,
  prefix = "",
  suffix = "",
  decimals = 0,
  icon: Icon
}: {
  value: number;
  label: string;
  sublabel?: string;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  icon: React.ElementType;
}) {
  const counter = useInViewCounter(value, {
    duration: 2000,
    decimals
  });

  return (
    <div ref={counter.ref} className="group">
      <div className="card-refined p-8 h-full">
        <div className="flex items-start justify-between mb-6">
          <div className="w-10 h-10 flex items-center justify-center border border-border group-hover:border-warm-brass/50 transition-colors duration-300">
            <Icon className="w-5 h-5 text-warm-brass" />
          </div>
        </div>
        <div className="metric-value text-foreground mb-2">
          {prefix}
          {decimals > 0 ? counter.value.toFixed(decimals) : Math.round(counter.value).toLocaleString()}
          {suffix}
        </div>
        <div className="text-sm text-muted-foreground font-medium">{label}</div>
        {sublabel && (
          <div className="text-xs text-muted-foreground/70 mt-1">{sublabel}</div>
        )}
      </div>
    </div>
  );
}

export default function PerformanceMetrics({
  totalPortfolioValue,
  totalUnits,
  totalEquityCreated,
  avgReturn,
  currentProperties,
  soldProperties,
  avgEquityMultiple,
  totalRealizedProfits,
  ctUnits = 0,
  flUnits = 0
}: PerformanceMetricsProps) {

  const formatValue = (value: number) => {
    if (value >= 1000000) {
      return value / 1000000;
    } else if (value >= 1000) {
      return value / 1000;
    }
    return value;
  };

  const getSuffix = (value: number) => {
    if (value >= 1000000) return "M";
    if (value >= 1000) return "K";
    return "";
  };

  const getDecimals = (value: number) => {
    if (value >= 1000000) return 2;
    return 0;
  };

  return (
    <section className="section-padding bg-soft-cream" data-testid="performance-metrics-section">
      <div className="container-wide">
        {/* Section Header */}
        <div className="text-center mb-16">
          <div className="divider mx-auto mb-6" />
          <h2 className="text-foreground mb-4" data-testid="performance-title">
            Historical Performance
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Complete portfolio metrics across all holdings and realized exits
          </p>
        </div>

        {/* Primary Metrics Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
          <MetricCard
            value={formatValue(totalPortfolioValue)}
            prefix="$"
            suffix={getSuffix(totalPortfolioValue)}
            decimals={getDecimals(totalPortfolioValue)}
            label="Total Portfolio Value"
            sublabel="Current + Sold"
            icon={DollarSign}
          />
          <MetricCard
            value={totalUnits}
            label="Total Units"
            sublabel="All Time"
            icon={Building2}
          />
          <MetricCard
            value={formatValue(totalEquityCreated)}
            prefix="$"
            suffix={getSuffix(totalEquityCreated)}
            decimals={getDecimals(totalEquityCreated)}
            label="Equity Created"
            icon={TrendingUp}
          />
          <MetricCard
            value={avgReturn}
            suffix="%"
            decimals={1}
            label="Avg Annualized Return"
            icon={BarChart3}
          />
        </div>

        {/* Secondary Metrics */}
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Portfolio Breakdown */}
          <div className="card-refined p-8">
            <h3 className="text-xl font-serif font-medium text-foreground mb-8">
              Portfolio Breakdown
            </h3>
            <div className="space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-border">
                <div className="flex items-center gap-3">
                  <MapPin className="w-4 h-4 text-warm-brass" />
                  <span className="text-muted-foreground">Connecticut</span>
                </div>
                <span className="font-medium text-foreground" data-testid="ct-units">{ctUnits} Units</span>
              </div>
              <div className="flex items-center justify-between pb-4 border-b border-border">
                <div className="flex items-center gap-3">
                  <MapPin className="w-4 h-4 text-warm-brass" />
                  <span className="text-muted-foreground">Florida</span>
                </div>
                <span className="font-medium text-foreground" data-testid="fl-units">{flUnits} Units</span>
              </div>
              <div className="flex items-center justify-between pt-2">
                <span className="text-muted-foreground font-medium">Average Equity Multiple</span>
                <span className="font-serif text-2xl text-warm-brass font-medium" data-testid="avg-equity-multiple">
                  {avgEquityMultiple.toFixed(2)}x
                </span>
              </div>
            </div>
          </div>

          {/* Investment Performance */}
          <div className="card-refined p-8">
            <h3 className="text-xl font-serif font-medium text-foreground mb-8">
              Investment Performance
            </h3>
            <div className="space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-border">
                <span className="text-muted-foreground">Properties Sold</span>
                <span className="font-medium text-foreground" data-testid="sold-properties-count">
                  {soldProperties} Properties
                </span>
              </div>
              <div className="flex items-center justify-between pb-4 border-b border-border">
                <span className="text-muted-foreground">Current Holdings</span>
                <span className="font-medium text-foreground" data-testid="current-properties-count">
                  {currentProperties} Properties
                </span>
              </div>
              <div className="flex items-center justify-between pt-2">
                <span className="text-muted-foreground font-medium">Total Realized Profits</span>
                <span className="font-serif text-2xl text-warm-brass font-medium" data-testid="realized-profits">
                  ${(totalRealizedProfits / 1000).toFixed(0)}K
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
