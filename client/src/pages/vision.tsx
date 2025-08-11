import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TrendingUp, Target, Globe, Building } from "lucide-react";
import { Link } from "wouter";

export default function Vision() {
  const milestones = [
    { year: "2025", target: "$25M", description: "Expand to 100+ units across CT and FL markets" },
    { year: "2030", target: "$100M", description: "Enter 3 new markets with 300+ units" },
    { year: "2040", target: "$500M", description: "Establish regional presence with 1,000+ units" },
    { year: "2050", target: "$1B", description: "Achieve national portfolio of 2,500+ units" },
  ];

  return (
    <div className="min-h-screen pt-16" data-testid="vision-page">
      {/* Hero Section */}
      <section className="py-20 bg-gradient-to-br from-primary to-gray-800 text-white relative overflow-hidden">
        <div className="geometric-pattern absolute inset-0 opacity-10"></div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center mb-16">
            <h1 className="text-5xl md:text-6xl font-serif font-bold mb-6" data-testid="vision-title">
              Our <span className="text-accent-gold">Vision</span>
            </h1>
            <p className="text-xl text-gray-300 max-w-3xl mx-auto">
              Building a $1 billion real estate portfolio by 2050 through strategic acquisitions and disciplined value creation
            </p>
          </div>
        </div>
      </section>

      {/* Vision Overview */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-6" data-testid="vision-overview-title">
                Transforming Real Estate Investment
              </h2>
              <p className="text-xl text-gray-600 mb-8 leading-relaxed">
                Our vision extends far beyond financial returns. We're building a platform that democratizes access to institutional-quality real estate investments while creating lasting value for communities, investors, and stakeholders.
              </p>
              
              <div className="space-y-6 text-gray-600 leading-relaxed" data-testid="vision-description">
                <p>
                  By 2050, 5Central Capital will manage a diversified portfolio of over 2,500 multifamily units across key growth markets in the United States. This ambitious goal represents more than just scale—it embodies our commitment to excellence, innovation, and sustainable growth.
                </p>
                
                <p>
                  Our strategic approach focuses on emerging markets with strong job growth, population influx, and limited housing supply. Through disciplined acquisition, strategic value-add improvements, and operational excellence, we aim to consistently deliver superior returns while contributing to housing solutions in high-demand areas.
                </p>
                
                <p>
                  This vision is supported by a foundation of proven performance, transparent operations, and aligned investor interests. Every step of our growth will maintain the same principles that have driven our success: strategic market selection, rigorous due diligence, and unwavering commitment to our partners.
                </p>
              </div>
            </div>

            <div className="text-center">
              <div className="relative">
                <div className="w-64 h-64 mx-auto rounded-full border-8 border-accent-gold/30 flex items-center justify-center mb-8 bg-gradient-to-br from-accent-gold/10 to-bronze/10">
                  <div className="text-center">
                    <div className="text-4xl md:text-5xl font-bold text-accent-gold mb-2" data-testid="vision-goal-amount">$1B</div>
                    <div className="text-lg text-gray-600">Portfolio Goal</div>
                    <div className="text-sm text-gray-500 mt-1">by 2050</div>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-6">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-accent-gold mb-1" data-testid="vision-stat-units">2,500+</div>
                    <div className="text-sm text-gray-500">Target Units</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-accent-gold mb-1" data-testid="vision-stat-markets">10+</div>
                    <div className="text-sm text-gray-500">Target Markets</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-accent-gold mb-1" data-testid="vision-stat-irr">20%+</div>
                    <div className="text-sm text-gray-500">Target IRR</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-accent-gold mb-1" data-testid="vision-stat-multiple">3.0x+</div>
                    <div className="text-sm text-gray-500">Target Multiple</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Strategic Pillars */}
      <section className="py-20 bg-gradient-to-br from-secondary to-gray-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-4">Strategic Pillars</h2>
            <p className="text-xl text-gray-600 max-w-3xl mx-auto">
              Four core principles that will guide our journey to building a billion-dollar real estate portfolio
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
            <Card className="bg-white rounded-2xl card-shadow premium-border p-8 text-center hover:shadow-xl transition-all duration-300 transform hover:-translate-y-2">
              <CardContent className="p-0">
                <div className="w-16 h-16 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-6">
                  <TrendingUp className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-xl font-serif font-semibold text-primary mb-4">Strategic Growth</h3>
                <p className="text-gray-600 leading-relaxed">
                  Disciplined expansion across high-growth markets, targeting 1,000+ units through strategic acquisitions and development partnerships by 2040.
                </p>
              </CardContent>
            </Card>

            <Card className="bg-white rounded-2xl card-shadow premium-border p-8 text-center hover:shadow-xl transition-all duration-300 transform hover:-translate-y-2">
              <CardContent className="p-0">
                <div className="w-16 h-16 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-6">
                  <Target className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-xl font-serif font-semibold text-primary mb-4">Market Leadership</h3>
                <p className="text-gray-600 leading-relaxed">
                  Establishing 5Central Capital as the premier multifamily investment platform in the Southeast and Northeast corridors.
                </p>
              </CardContent>
            </Card>

            <Card className="bg-white rounded-2xl card-shadow premium-border p-8 text-center hover:shadow-xl transition-all duration-300 transform hover:-translate-y-2">
              <CardContent className="p-0">
                <div className="w-16 h-16 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-6">
                  <Globe className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-xl font-serif font-semibold text-primary mb-4">Innovation Focus</h3>
                <p className="text-gray-600 leading-relaxed">
                  Leveraging technology and data analytics to identify opportunities, optimize operations, and deliver superior returns to investment partners.
                </p>
              </CardContent>
            </Card>

            <Card className="bg-white rounded-2xl card-shadow premium-border p-8 text-center hover:shadow-xl transition-all duration-300 transform hover:-translate-y-2">
              <CardContent className="p-0">
                <div className="w-16 h-16 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-6">
                  <Building className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-xl font-serif font-semibold text-primary mb-4">Community Impact</h3>
                <p className="text-gray-600 leading-relaxed">
                  Creating positive community impact through quality housing, responsible property management, and local economic development.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Growth Timeline */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-4">Growth Roadmap</h2>
            <p className="text-xl text-gray-600 max-w-3xl mx-auto">
              Our strategic milestones on the path to building a $1 billion real estate portfolio
            </p>
          </div>

          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-1/2 transform -translate-x-0.5 w-1 h-full bg-accent-gold/30 hidden lg:block"></div>
            
            <div className="space-y-12 lg:space-y-16" data-testid="growth-timeline">
              {milestones.map((milestone, index) => (
                <div key={milestone.year} className={`flex flex-col lg:flex-row items-center gap-8 ${index % 2 === 0 ? 'lg:flex-row' : 'lg:flex-row-reverse'}`}>
                  {/* Timeline marker */}
                  <div className="hidden lg:block absolute left-1/2 transform -translate-x-1/2 w-4 h-4 bg-accent-gold rounded-full border-4 border-white shadow-lg z-10"></div>
                  
                  <div className={`flex-1 ${index % 2 === 0 ? 'lg:text-right' : 'lg:text-left'}`}>
                    <Card className="bg-gradient-to-br from-secondary to-gray-100 rounded-2xl p-8 card-shadow premium-border hover:shadow-xl transition-all duration-300">
                      <CardContent className="p-0">
                        <div className={`flex items-center gap-4 mb-4 ${index % 2 === 0 ? 'lg:justify-end' : 'lg:justify-start'}`}>
                          <div className="text-3xl font-bold text-accent-gold" data-testid={`milestone-year-${milestone.year}`}>
                            {milestone.year}
                          </div>
                          <div className="text-4xl font-bold text-primary" data-testid={`milestone-target-${milestone.year}`}>
                            {milestone.target}
                          </div>
                        </div>
                        <p className="text-lg text-gray-600 leading-relaxed" data-testid={`milestone-description-${milestone.year}`}>
                          {milestone.description}
                        </p>
                      </CardContent>
                    </Card>
                  </div>
                  
                  <div className="flex-1 lg:flex-shrink-0 lg:w-1/2"></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Market Strategy */}
      <section className="py-20 bg-gradient-to-br from-secondary to-gray-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-4">Market Strategy</h2>
            <p className="text-xl text-gray-600 max-w-3xl mx-auto">
              Our systematic approach to market selection and expansion
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <h3 className="text-3xl font-serif font-bold text-primary mb-6">Target Market Criteria</h3>
              <div className="space-y-6">
                <div className="flex items-start gap-4">
                  <div className="w-3 h-3 bg-accent-gold rounded-full mt-2 flex-shrink-0"></div>
                  <div>
                    <h4 className="text-lg font-semibold text-primary mb-2">Population Growth</h4>
                    <p className="text-gray-600">Markets with 2%+ annual population growth and strong job creation</p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-3 h-3 bg-accent-gold rounded-full mt-2 flex-shrink-0"></div>
                  <div>
                    <h4 className="text-lg font-semibold text-primary mb-2">Housing Demand</h4>
                    <p className="text-gray-600">Supply-constrained markets with rental occupancy rates above 95%</p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-3 h-3 bg-accent-gold rounded-full mt-2 flex-shrink-0"></div>
                  <div>
                    <h4 className="text-lg font-semibold text-primary mb-2">Economic Fundamentals</h4>
                    <p className="text-gray-600">Diverse employment base with median incomes supporting target rent levels</p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-3 h-3 bg-accent-gold rounded-full mt-2 flex-shrink-0"></div>
                  <div>
                    <h4 className="text-lg font-semibold text-primary mb-2">Investment Climate</h4>
                    <p className="text-gray-600">Business-friendly regulations and favorable property tax structures</p>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <Card className="bg-white rounded-2xl card-shadow premium-border p-8">
                <CardContent className="p-0">
                  <h3 className="text-3xl font-serif font-bold text-primary mb-6">Expansion Timeline</h3>
                  <div className="space-y-6">
                    <div className="border-l-4 border-accent-gold pl-6">
                      <h4 className="text-lg font-semibold text-primary mb-2">Phase 1: 2024-2027</h4>
                      <p className="text-gray-600 mb-2">Consolidate CT and FL markets</p>
                      <p className="text-sm text-accent-gold font-medium">Target: 150 units</p>
                    </div>
                    <div className="border-l-4 border-accent-gold pl-6">
                      <h4 className="text-lg font-semibold text-primary mb-2">Phase 2: 2028-2032</h4>
                      <p className="text-gray-600 mb-2">Expand to NC, SC, and GA markets</p>
                      <p className="text-sm text-accent-gold font-medium">Target: 500 units</p>
                    </div>
                    <div className="border-l-4 border-accent-gold pl-6">
                      <h4 className="text-lg font-semibold text-primary mb-2">Phase 3: 2033-2040</h4>
                      <p className="text-gray-600 mb-2">Enter TX, TN, and VA markets</p>
                      <p className="text-sm text-accent-gold font-medium">Target: 1,000 units</p>
                    </div>
                    <div className="border-l-4 border-accent-gold pl-6">
                      <h4 className="text-lg font-semibold text-primary mb-2">Phase 4: 2041-2050</h4>
                      <p className="text-gray-600 mb-2">National platform with selective markets</p>
                      <p className="text-sm text-accent-gold font-medium">Target: 2,500 units</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </section>

      {/* Call to Action */}
      <section className="py-20 bg-gradient-to-br from-primary to-gray-800 text-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-4xl md:text-5xl font-serif font-bold mb-6">Join Our Vision</h2>
          <p className="text-xl text-gray-300 mb-12 max-w-2xl mx-auto">
            Be part of building the next generation real estate investment platform. Together, we'll create exceptional returns while making a lasting impact on communities across America.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-6 justify-center">
            <Link href="/founder">
              <Button 
                className="bg-gradient-to-r from-accent-gold to-bronze text-white px-10 py-4 rounded-lg font-semibold text-lg hover:shadow-lg transition-all duration-300 transform hover:-translate-y-1"
                data-testid="button-meet-founder"
              >
                Meet the Founder
              </Button>
            </Link>
            <Link href="/portfolio">
              <Button 
                variant="outline"
                className="border-2 border-accent-gold text-accent-gold px-10 py-4 rounded-lg font-semibold text-lg hover:bg-accent-gold hover:text-primary transition-all duration-300"
                data-testid="button-view-current-portfolio"
              >
                View Current Portfolio
              </Button>
            </Link>
          </div>
          
          <div className="mt-16 grid md:grid-cols-3 gap-8 text-center">
            <div>
              <div className="text-3xl font-bold text-accent-gold mb-2" data-testid="vision-cta-goal">$1B</div>
              <div className="text-gray-300">Portfolio Goal by 2050</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-accent-gold mb-2" data-testid="vision-cta-experience">10+</div>
              <div className="text-gray-300">Years Experience</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-accent-gold mb-2" data-testid="vision-cta-track-record">3.02x</div>
              <div className="text-gray-300">Avg Equity Multiple</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
