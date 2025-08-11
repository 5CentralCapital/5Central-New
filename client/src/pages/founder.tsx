import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Mail, Linkedin, Building2 } from "lucide-react";

export default function Founder() {
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
                src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=800&h=900" 
                alt="Michael McElwee - Founder" 
                className="w-full h-96 object-cover rounded-2xl card-shadow"
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
                  With over a decade of experience in real estate investment and development, Michael founded 5Central Capital in 2020 to democratize access to high-quality multifamily investment opportunities. His vision was simple yet ambitious: create a platform that delivers institutional-quality returns while maintaining the personal touch and transparency that individual investors deserve.
                </p>
                
                <p>
                  Michael's disciplined approach to value creation has generated exceptional returns across multiple market cycles, with a track record spanning 47 units and over $10 million in portfolio value. His success stems from a unique combination of analytical rigor, operational expertise, and deep market knowledge gained through hands-on property management and renovation experience.
                </p>
                
                <p>
                  Before founding 5Central Capital, Michael honed his skills in both traditional and alternative real estate investments, developing a keen eye for undervalued assets with significant upside potential. His investment philosophy centers on strategic market selection, rigorous due diligence, and operational excellence to create sustainable wealth for all stakeholders.
                </p>

                <p>
                  Michael believes that real estate investment success comes from three core principles: buying right, adding value through strategic improvements, and timing the market for optimal exits. This methodical approach has enabled 5Central Capital to consistently exceed industry benchmarks while building long-term relationships with investors, partners, and communities.
                </p>
              </div>

              <div className="mt-8 grid grid-cols-3 gap-4">
                <Card className="bg-secondary rounded-lg p-4 text-center">
                  <CardContent className="p-0">
                    <div className="text-2xl font-bold text-primary" data-testid="founder-stat-properties">13</div>
                    <div className="text-sm text-gray-600">Properties Acquired</div>
                  </CardContent>
                </Card>
                <Card className="bg-secondary rounded-lg p-4 text-center">
                  <CardContent className="p-0">
                    <div className="text-2xl font-bold text-primary" data-testid="founder-stat-experience">4.5</div>
                    <div className="text-sm text-gray-600">Years Experience</div>
                  </CardContent>
                </Card>
                <Card className="bg-secondary rounded-lg p-4 text-center">
                  <CardContent className="p-0">
                    <div className="text-2xl font-bold text-primary" data-testid="founder-stat-assets">$10.2M</div>
                    <div className="text-sm text-gray-600">Assets Under Mgmt</div>
                  </CardContent>
                </Card>
              </div>

              <div className="mt-8 flex flex-wrap gap-4">
                <Button 
                  className="bg-gradient-to-r from-accent-gold to-bronze text-white px-8 py-4 rounded-lg font-semibold hover:shadow-lg transition-all duration-300 transform hover:-translate-y-0.5"
                  data-testid="button-connect-michael"
                >
                  <Mail className="w-5 h-5 mr-2" />
                  Connect with Michael
                </Button>
                <Button 
                  variant="outline"
                  className="border-2 border-primary text-primary px-8 py-4 rounded-lg font-semibold hover:bg-primary hover:text-white transition-all duration-300"
                  data-testid="button-linkedin-profile"
                >
                  <Linkedin className="w-5 h-5 mr-2" />
                  LinkedIn Profile
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
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                  </svg>
                </div>
                <h3 className="text-xl font-serif font-semibold text-primary mb-4">Market Timing</h3>
                <p className="text-gray-600 leading-relaxed">
                  Execute strategic exits at optimal market conditions to maximize returns, while maintaining a long-term perspective on market cycles and trends.
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
            >
              Schedule a Meeting
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
