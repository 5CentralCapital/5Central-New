import { Card, CardContent } from "@/components/ui/card";
import { TrendingUp, Home, DollarSign, BarChart3 } from "lucide-react";

interface PerformanceMetricsProps {
  totalPortfolioValue: number;
  totalUnits: number;
  totalEquityCreated: number;
  avgReturn: number;
  currentProperties: number;
  soldProperties: number;
  avgEquityMultiple: number;
  totalRealizedProfits: number;
}

export default function PerformanceMetrics({ 
  totalPortfolioValue,
  totalUnits,
  totalEquityCreated,
  avgReturn,
  currentProperties,
  soldProperties,
  avgEquityMultiple,
  totalRealizedProfits
}: PerformanceMetricsProps) {
  
  const formatCurrency = (value: number) => {
    if (value >= 1000000) {
      return `$${(value / 1000000).toFixed(2)}M`;
    } else if (value >= 1000) {
      return `$${(value / 1000).toFixed(0)}K`;
    }
    return `$${value.toLocaleString()}`;
  };

  const equityPercentage = Math.round((totalEquityCreated / totalPortfolioValue) * 100);

  return (
    <section className="py-20 bg-gradient-to-br from-secondary to-gray-100" data-testid="performance-metrics-section">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-4" data-testid="performance-title">
            Historical Performance
          </h2>
          <p className="text-xl text-gray-600 max-w-3xl mx-auto">
            Total performance metrics across our complete portfolio history including both current holdings and realized exits
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8 mb-12">
          <Card className="bg-white rounded-2xl p-8 card-shadow text-center premium-border hover:shadow-xl transition-all duration-300">
            <CardContent className="p-0">
              <div className="w-16 h-16 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-4">
                <DollarSign className="w-8 h-8 text-white" />
              </div>
              <div className="text-3xl font-bold text-primary mb-2" data-testid="metric-portfolio-value">
                {formatCurrency(totalPortfolioValue)}
              </div>
              <div className="text-gray-600 font-medium">Total Portfolio Value<br/><span className="text-sm">(Current + Sold)</span></div>
            </CardContent>
          </Card>

          <Card className="bg-white rounded-2xl p-8 card-shadow text-center premium-border hover:shadow-xl transition-all duration-300">
            <CardContent className="p-0">
              <div className="w-16 h-16 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-4">
                <Home className="w-8 h-8 text-white" />
              </div>
              <div className="text-3xl font-bold text-primary mb-2" data-testid="metric-total-units">
                {totalUnits}
              </div>
              <div className="text-gray-600 font-medium">Total Units<br/><span className="text-sm">(All Time)</span></div>
            </CardContent>
          </Card>

          <Card className="bg-white rounded-2xl p-8 card-shadow text-center premium-border hover:shadow-xl transition-all duration-300">
            <CardContent className="p-0">
              <div className="w-16 h-16 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-4">
                <TrendingUp className="w-8 h-8 text-white" />
              </div>
              <div className="text-3xl font-bold text-primary mb-2" data-testid="metric-equity-created">
                {formatCurrency(totalEquityCreated)}
              </div>
              <div className="text-gray-600 font-medium">Total Equity Created</div>
            </CardContent>
          </Card>

          <Card className="bg-white rounded-2xl p-8 card-shadow text-center premium-border hover:shadow-xl transition-all duration-300">
            <CardContent className="p-0">
              <div className="w-16 h-16 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-4">
                <BarChart3 className="w-8 h-8 text-white" />
              </div>
              <div className="text-3xl font-bold text-primary mb-2" data-testid="metric-avg-return">
                {avgReturn.toFixed(1)}%
              </div>
              <div className="text-gray-600 font-medium">Avg Annualized Return</div>
            </CardContent>
          </Card>
        </div>

        {/* Additional Metrics Row */}
        <div className="grid md:grid-cols-2 gap-8">
          <Card className="bg-white rounded-2xl p-8 card-shadow premium-border">
            <CardContent className="p-0">
              <h3 className="text-2xl font-serif font-bold text-primary mb-6">Portfolio Breakdown</h3>
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-gray-600">Connecticut Properties</span>
                  <span className="font-semibold text-primary" data-testid="ct-units">37 Units</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-600">Florida Properties</span>
                  <span className="font-semibold text-primary" data-testid="fl-units">10 Units</span>
                </div>
                <div className="flex justify-between items-center border-t pt-4">
                  <span className="text-gray-600 font-medium">Average Equity Multiple</span>
                  <span className="font-bold text-accent-gold text-xl" data-testid="avg-equity-multiple">
                    {avgEquityMultiple.toFixed(2)}x
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-white rounded-2xl p-8 card-shadow premium-border">
            <CardContent className="p-0">
              <h3 className="text-2xl font-serif font-bold text-primary mb-6">Investment Performance</h3>
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-gray-600">Properties Sold</span>
                  <span className="font-semibold text-primary" data-testid="sold-properties-count">
                    {soldProperties} Properties
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-600">Current Holdings</span>
                  <span className="font-semibold text-primary" data-testid="current-properties-count">
                    {currentProperties} Properties
                  </span>
                </div>
                <div className="flex justify-between items-center border-t pt-4">
                  <span className="text-gray-600 font-medium">Total Realized Profits</span>
                  <span className="font-bold text-accent-gold text-xl" data-testid="realized-profits">
                    {formatCurrency(totalRealizedProfits)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
