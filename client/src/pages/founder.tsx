import { useQuery } from "@tanstack/react-query";
import { type Property } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Mail, Linkedin, Building2 } from "lucide-react";

export default function Founder() {
  const { data: allProperties = [], isLoading } = useQuery<Property[]>({
    queryKey: ["/api/properties"],
  });

  // Calculate dynamic statistics
  const totalProperties = allProperties.length;
  const currentProperties = allProperties.filter(p => p.status === "current");
  const soldProperties = allProperties.filter(p => p.status === "sold");
  
  const totalPortfolioValue = allProperties.reduce((sum, p) => {
    const value = parseFloat(p.currentValue || p.salePrice || "0");
    return sum + value;
  }, 0);
  
  const totalUnits = allProperties.reduce((sum, p) => sum + p.units, 0);
  
  const totalCashflow = allProperties.reduce((sum, p) => {
    const cashflow = parseFloat(p.totalCashflow || "0");
    return sum + cashflow;
  }, 0);
  
  const averageIRR = allProperties.length > 0 ? 
    allProperties.reduce((sum, p) => sum + parseFloat(p.irr || "0"), 0) / allProperties.length : 0;
    
  const averageEquityMultiple = allProperties.length > 0 ?
    allProperties.reduce((sum, p) => sum + parseFloat(p.equityMultiple || "0"), 0) / allProperties.length : 0;
    
  const yearsExperience = 4.5; // Started in 2020, now 2025

  const formatCurrency = (value: number) => {
    if (value >= 1000000) {
      return `$${(value / 1000000).toFixed(1)}M`;
    } else if (value >= 1000) {
      return `$${(value / 1000).toFixed(0)}K`;
    }
    return `$${value.toLocaleString()}`;
  };

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }
  return (
    <div className="min-h-screen pt-16" data-testid="founder-page">
      {/* Hero Section */}
      <section className="py-20 bg-gradient-to-br from-primary to-gray-800 text-white relative overflow-hidden">
        <div className="geometric-pattern absolute inset-0 opacity-10"></div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center mb-16">
            <h1 className="text-5xl md:text-6xl font-serif font-bold mb-6" data-testid="founder-title">
              Meet <span className="text-accent-gold">Michael McElwee</span>
            </h1>
            <p className="text-xl text-gray-300 max-w-3xl mx-auto">
              Founder and Principal of 5Central Capital
            </p>
          </div>
        </div>
      </section>

      {/* Main Content */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <img 
                src="/founder-logo.jpg" 
                alt="5Central Capital Logo" 
                className="w-full h-[500px] object-contain"
                data-testid="founder-image"
              />
            </div>
            <div>
              <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-6" data-testid="founder-name">
                Michael McElwee
              </h2>
              <p className="text-xl text-accent-gold mb-8 leading-relaxed font-medium">
                Founder and Principal of 5Central Capital
              </p>
              
              <div className="space-y-6 text-gray-600 leading-relaxed" data-testid="founder-bio">
                <p>
                  I started in 2020 with an FHA loan, a W-2, and a blunt strategy: buy under-managed assets and force performance. After the first deal, I used two friends' FHA loans to pick up ten Connecticut houses and convert them into ~120 rentable rooms. It was messy, labor-heavy, and the best training in operations, tenant management, and expense control I could have asked for.
                </p>
                
                <p>
                  In 2024 I refinanced, pulled $300k, and moved to Tampa to scale where the upside pays. My first Florida multifamily, a 10-unit at 3408 E Dr. MLK Blvd, outperformed my entire CT portfolio. That locked my focus: 10–20-unit value-add multifamily across the Tampa region.
                </p>
                
                <p>
                  Today I manage {formatCurrency(totalPortfolioValue)} in assets, self-managing renovations with tight crews and no GC markups. The system is simple and repeatable: 85% LTC bridge, heavy rehab fast, refinance in 4–6 months at ≤70% LTV, then recycle capital. Underwriting is disciplined: neighborhood-specific rents, a 40% OpEx baseline, DSCR ≥ 1.20× at refi, and exit caps stressed 50–100 bps. To keep liquidity turning, I run select 1–4-unit flips at 100% LTC that net $60–80k in roughly four months.
                </p>

                <div className="mt-8">
                  <h3 className="text-xl font-semibold text-primary mb-4">What's Next</h3>
                  <p>
                    I'm scaling a Tampa-first, operations-led platform focused on C/C+ assets with clear management and OpEx wins. Near-term goal: $7.1M AUM by year-end 2025. Medium term: $50M by 2030 through steady, repeatable 10–20-unit acquisitions and fast turns. Long term: $1B by 2050, built on disciplined cash recycling and 1031s.
                  </p>
                </div>

                <div className="mt-8">
                  <h3 className="text-xl font-semibold text-primary mb-4">For Prospective LPs</h3>
                  <div className="space-y-3">
                    <p><strong>Strategy:</strong> Buy right, fix fast, refinance aggressively. Target assets where operations, not speculation, create value.</p>
                    <p><strong>Edge:</strong> Hyper-local execution, speed, and cost control. We do the work ourselves with vetted crews and tight scopes.</p>
                    <p><strong>Alignment:</strong> I co-invest meaningful capital in every deal and underwrite to the same downside you care about. Personal guarantees are on the table when needed.</p>
                    <p><strong>Risk Controls:</strong> 85% LTC max at acquisition, 70% LTV refi, 40% OpEx baseline, DSCR ≥ 1.20× post-refi, interest-rate and exit-cap stress tests, 120–150-day turn targets.</p>
                    <p><strong>Transparency:</strong> Standardized reporting and a real-time dashboard that tracks occupancy, rent collection, rehab budget, DSCR, and cash position.</p>
                  </div>
                  <p className="mt-4">
                    I'm opening a limited allocation for LP co-investments in select Tampa deals where the plan is clear and timelines are tight. The objective is simple: recycle capital twice per year, protect the downside through disciplined underwriting and execution, and let the compounding do the heavy lifting.
                  </p>
                </div>
              </div>

              <div className="mt-8 grid grid-cols-2 md:grid-cols-3 gap-4">
                <Card className="bg-secondary rounded-lg p-4 text-center">
                  <CardContent className="p-0">
                    <div className="text-2xl font-bold text-primary" data-testid="founder-stat-properties">{totalProperties}</div>
                    <div className="text-sm text-gray-600">Properties Acquired</div>
                  </CardContent>
                </Card>
                <Card className="bg-secondary rounded-lg p-4 text-center">
                  <CardContent className="p-0">
                    <div className="text-2xl font-bold text-primary" data-testid="founder-stat-units">{totalUnits}</div>
                    <div className="text-sm text-gray-600">Total Units</div>
                  </CardContent>
                </Card>
                <Card className="bg-secondary rounded-lg p-4 text-center">
                  <CardContent className="p-0">
                    <div className="text-2xl font-bold text-primary" data-testid="founder-stat-assets">{formatCurrency(totalPortfolioValue)}</div>
                    <div className="text-sm text-gray-600">Portfolio Value</div>
                  </CardContent>
                </Card>
                <Card className="bg-secondary rounded-lg p-4 text-center">
                  <CardContent className="p-0">
                    <div className="text-2xl font-bold text-primary" data-testid="founder-stat-irr">{averageIRR.toFixed(1)}%</div>
                    <div className="text-sm text-gray-600">Average IRR</div>
                  </CardContent>
                </Card>
                <Card className="bg-secondary rounded-lg p-4 text-center">
                  <CardContent className="p-0">
                    <div className="text-2xl font-bold text-primary" data-testid="founder-stat-multiple">{averageEquityMultiple.toFixed(1)}x</div>
                    <div className="text-sm text-gray-600">Avg Equity Multiple</div>
                  </CardContent>
                </Card>
              </div>

              <div className="mt-8">
                <Button 
                  className="bg-gradient-to-r from-accent-gold to-bronze text-white px-8 py-4 rounded-lg font-semibold hover:shadow-lg transition-all duration-300 transform hover:-translate-y-0.5"
                  data-testid="button-connect-michael"
                  asChild
                >
                  <a href="mailto:michael@5central.capital">
                    <Mail className="w-5 h-5 mr-2" />
                    Connect with Michael
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Investment Philosophy */}
      <section className="py-20 bg-gradient-to-br from-secondary to-gray-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-4">Investment Philosophy</h2>
            <p className="text-xl text-gray-600 max-w-3xl mx-auto">
              Michael's approach to real estate investment is built on proven principles and unwavering commitment to excellence
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            <Card className="bg-white rounded-2xl card-shadow premium-border p-8 text-center hover:shadow-xl transition-all duration-300">
              <CardContent className="p-0">
                <div className="w-16 h-16 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-6">
                  <Building2 className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-xl font-serif font-semibold text-primary mb-4">Strategic Acquisition</h3>
                <p className="text-gray-600 leading-relaxed">
                  Focus on undervalued properties in emerging markets with strong fundamentals, ensuring each acquisition meets strict criteria for cash flow and appreciation potential.
                </p>
              </CardContent>
            </Card>

            <Card className="bg-white rounded-2xl card-shadow premium-border p-8 text-center hover:shadow-xl transition-all duration-300">
              <CardContent className="p-0">
                <div className="w-16 h-16 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-6">
                  <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                  </svg>
                </div>
                <h3 className="text-xl font-serif font-semibold text-primary mb-4">Value Creation</h3>
                <p className="text-gray-600 leading-relaxed">
                  Implement strategic renovations and operational improvements to maximize NOI and asset value, creating win-win scenarios for investors and tenants.
                </p>
              </CardContent>
            </Card>

            <Card className="bg-white rounded-2xl card-shadow premium-border p-8 text-center hover:shadow-xl transition-all duration-300">
              <CardContent className="p-0">
                <div className="w-16 h-16 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-6">
                  <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z" clipRule="evenodd" />
                  </svg>
                </div>
                <h3 className="text-xl font-serif font-semibold text-primary mb-4">Speed of Execution</h3>
                <p className="text-gray-600 leading-relaxed">
                  Rapid deal closing, fast renovations with tight crews, and quick refinancing to maximize capital velocity and returns through disciplined execution timelines.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Leadership Principles */}
      <section className="py-20 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-4">Leadership Principles</h2>
            <p className="text-xl text-gray-600">
              The core values that guide Michael's approach to business and investment decisions
            </p>
          </div>

          <div className="space-y-8" data-testid="leadership-principles">
            <Card className="bg-gradient-to-r from-secondary to-gray-100 rounded-2xl p-8 premium-border">
              <CardContent className="p-0">
                <h3 className="text-2xl font-serif font-bold text-primary mb-4">Transparency & Trust</h3>
                <p className="text-gray-600 leading-relaxed">
                  Every investment decision, performance metric, and market insight is shared openly with partners. Michael believes that informed investors make better partners, and transparency builds the foundation for long-term success.
                </p>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-r from-secondary to-gray-100 rounded-2xl p-8 premium-border">
              <CardContent className="p-0">
                <h3 className="text-2xl font-serif font-bold text-primary mb-4">Aligned Interests</h3>
                <p className="text-gray-600 leading-relaxed">
                  Michael invests his own capital alongside every partner, ensuring that success is truly shared. This alignment of interests means that when investors profit, so does the 5Central Capital team.
                </p>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-r from-secondary to-gray-100 rounded-2xl p-8 premium-border">
              <CardContent className="p-0">
                <h3 className="text-2xl font-serif font-bold text-primary mb-4">Continuous Learning</h3>
                <p className="text-gray-600 leading-relaxed">
                  Real estate markets evolve constantly, and Michael stays ahead through continuous education, market analysis, and adaptation of strategies based on changing conditions and new opportunities.
                </p>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-r from-secondary to-gray-100 rounded-2xl p-8 premium-border">
              <CardContent className="p-0">
                <h3 className="text-2xl font-serif font-bold text-primary mb-4">Community Impact</h3>
                <p className="text-gray-600 leading-relaxed">
                  Beyond financial returns, Michael focuses on improving communities through quality housing and responsible property management, creating positive impact that extends far beyond the investment itself.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Call to Action */}
      <section className="py-20 bg-gradient-to-br from-primary to-gray-800 text-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-4xl md:text-5xl font-serif font-bold mb-6">Ready to Partner with Michael?</h2>
          <p className="text-xl text-gray-300 mb-12 max-w-2xl mx-auto">
            Connect with Michael to discuss investment opportunities and learn how 5Central Capital can help you achieve your real estate investment goals.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-6 justify-center">
            <Button 
              className="bg-gradient-to-r from-accent-gold to-bronze text-white px-10 py-4 rounded-lg font-semibold text-lg hover:shadow-lg transition-all duration-300 transform hover:-translate-y-1"
              data-testid="button-schedule-meeting"
              asChild
            >
              <a href="mailto:michael@5central.capital">Schedule a Meeting</a>
            </Button>
            <Button 
              variant="outline"
              className="border-2 border-accent-gold text-accent-gold px-10 py-4 rounded-lg font-semibold text-lg hover:bg-accent-gold hover:text-primary transition-all duration-300"
              data-testid="button-view-portfolio"
            >
              View Portfolio
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
