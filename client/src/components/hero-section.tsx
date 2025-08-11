import { Button } from "@/components/ui/button";
import { Link } from "wouter";

export default function HeroSection() {
  return (
    <section className="pt-24 pb-20 relative overflow-hidden" style={{ height: '70vh' }}>
      {/* Multifamily Apartment Building Background */}
      <div 
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: 'url(https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D&auto=format&fit=crop&w=2070&q=80)',
        }}
      ></div>
      {/* Dark overlay for text readability */}
      <div className="absolute inset-0 bg-black bg-opacity-50"></div>
      <div className="geometric-pattern absolute inset-0 opacity-20"></div>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10 h-full flex items-center justify-center">
        <div className="text-center w-full">
          <h1 className="text-5xl md:text-7xl font-serif font-bold text-white mb-6 leading-tight" data-testid="hero-title">
            5Central <span className="text-accent-gold">Capital</span>
          </h1>
          <p className="text-xl md:text-2xl text-gray-200 mb-8 max-w-3xl mx-auto leading-relaxed" data-testid="hero-description">
            Tampa-based investment firm specializing in high-return multifamily acquisitions with proven value creation through disciplined execution and strategic financing.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-12">
            <Link href="/portfolio">
              <Button 
                className="bg-accent-gold text-primary px-8 py-4 rounded-lg font-semibold text-lg hover:bg-yellow-400 transition-all duration-300 transform hover:-translate-y-1 shadow-lg"
                data-testid="button-view-portfolio"
              >
                View Our Portfolio
              </Button>
            </Link>
            <Button 
              variant="outline"
              className="border-2 border-accent-gold text-accent-gold px-8 py-4 rounded-lg font-semibold text-lg hover:bg-accent-gold hover:text-primary transition-all duration-300"
              data-testid="button-investment-opportunities"
            >
              Investment Opportunities
            </Button>
          </div>
          
          {/* Key Metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mt-16" data-testid="hero-metrics">
            <div className="text-center">
              <div className="text-3xl md:text-4xl font-bold text-accent-gold mb-2" data-testid="metric-portfolio-value">$10.2M</div>
              <div className="text-gray-300 text-sm uppercase tracking-wide">Portfolio Value</div>
            </div>
            <div className="text-center">
              <div className="text-3xl md:text-4xl font-bold text-accent-gold mb-2" data-testid="metric-total-units">47</div>
              <div className="text-gray-300 text-sm uppercase tracking-wide">Total Units</div>
            </div>
            <div className="text-center">
              <div className="text-3xl md:text-4xl font-bold text-accent-gold mb-2" data-testid="metric-avg-equity-multiple">3.02x</div>
              <div className="text-gray-300 text-sm uppercase tracking-wide">Avg Equity Multiple</div>
            </div>
            <div className="text-center">
              <div className="text-3xl md:text-4xl font-bold text-accent-gold mb-2" data-testid="metric-avg-return">85.3%</div>
              <div className="text-gray-300 text-sm uppercase tracking-wide">Avg Return</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
