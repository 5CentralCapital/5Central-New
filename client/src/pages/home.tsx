import { useQuery } from "@tanstack/react-query";
import { type Property } from "@shared/schema";
import HeroSection from "@/components/hero-section";
import PropertyCard from "@/components/property-card";
import PerformanceMetrics from "@/components/performance-metrics";
import { getPropertyImage } from "@/lib/property-data";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { 
  CheckCircle, 
  Award, 
  Users, 
  FileText, 
  Plus,
  Mail,
  Phone,
  MapPin
} from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

export default function Home() {
  const { data: currentProperties = [], isLoading: currentLoading } = useQuery<Property[]>({
    queryKey: ["/api/properties/current"],
  });

  const { data: allProperties = [], isLoading: allLoading } = useQuery<Property[]>({
    queryKey: ["/api/properties"],
  });

  const isLoading = currentLoading || allLoading;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="loading-state">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  // Calculate performance metrics
  const soldProperties = allProperties.filter(p => p.status === 'sold');
  const totalPortfolioValue = allProperties.reduce((sum, p) => {
    const value = parseFloat(p.currentValue || p.salePrice || "0");
    return sum + value;
  }, 0);

  const totalUnits = allProperties.reduce((sum, p) => sum + p.units, 0);
  
  const totalEquityCreated = allProperties.reduce((sum, p) => {
    const acquisitionPrice = parseFloat(p.acquisitionPrice);
    const currentValue = parseFloat(p.currentValue || p.salePrice || "0");
    return sum + Math.max(0, currentValue - acquisitionPrice);
  }, 0);

  const avgReturn = allProperties.reduce((sum, p) => {
    const irr = parseFloat(p.irr || "0");
    return sum + irr;
  }, 0) / allProperties.length;

  const avgEquityMultiple = allProperties.reduce((sum, p) => {
    const multiple = parseFloat(p.equityMultiple || "0");
    return sum + multiple;
  }, 0) / allProperties.length;

  const totalRealizedProfits = soldProperties.reduce((sum, p) => {
    const acquisitionPrice = parseFloat(p.acquisitionPrice);
    const salePrice = parseFloat(p.salePrice || "0");
    return sum + Math.max(0, salePrice - acquisitionPrice);
  }, 0);

  return (
    <div className="min-h-screen" data-testid="home-page">
      <HeroSection />

      {/* Featured Properties */}
      <section id="portfolio" className="py-20 bg-white" data-testid="featured-properties-section">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-4">Featured Properties</h2>
            <p className="text-xl text-gray-600 max-w-3xl mx-auto">
              Current multifamily investments showcasing our value-add strategy with real property photos and verified performance metrics
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8 mb-12" data-testid="property-grid">
            {currentProperties.slice(0, 3).map((property) => (
              <PropertyCard
                key={property.id}
                property={property}
                imageUrl={getPropertyImage(property.name)}
              />
            ))}
          </div>

          <div className="text-center">
            <Link href="/portfolio">
              <Button 
                className="bg-primary text-white px-8 py-4 rounded-lg font-semibold hover:bg-gray-800 transition-colors duration-300"
                data-testid="button-view-complete-portfolio"
              >
                View Complete Portfolio
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Performance Metrics */}
      <PerformanceMetrics
        totalPortfolioValue={totalPortfolioValue}
        totalUnits={totalUnits}
        totalEquityCreated={totalEquityCreated}
        avgReturn={avgReturn}
        currentProperties={currentProperties.length}
        soldProperties={soldProperties.length}
        avgEquityMultiple={avgEquityMultiple}
        totalRealizedProfits={totalRealizedProfits}
      />

      {/* Why Partner With Us */}
      <section className="py-20 bg-white" data-testid="why-partner-section">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-4">Why Partner With Us</h2>
            <p className="text-xl text-gray-600 max-w-3xl mx-auto">
              Our proven methodology combines aggressive value creation with strategic financing to deliver industry-leading returns for our investment partners.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
            <div className="text-center">
              <div className="w-20 h-20 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-6">
                <CheckCircle className="w-10 h-10 text-white" />
              </div>
              <h3 className="text-xl font-serif font-semibold text-primary mb-4">Exceptional Returns</h3>
              <p className="text-gray-600">
                Consistently deliver 3.0x+ equity multiples through strategic value-add renovations, operational improvements, and market timing expertise.
              </p>
            </div>

            <div className="text-center">
              <div className="w-20 h-20 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-6">
                <Award className="w-10 h-10 text-white" />
              </div>
              <h3 className="text-xl font-serif font-semibold text-primary mb-4">Proven Track Record</h3>
              <p className="text-gray-600">
                Successfully acquired 47 units across 13 properties in Connecticut and Florida with documented performance metrics and transparent reporting.
              </p>
            </div>

            <div className="text-center">
              <div className="w-20 h-20 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-6">
                <Users className="w-10 h-10 text-white" />
              </div>
              <h3 className="text-xl font-serif font-semibold text-primary mb-4">Principal Investment</h3>
              <p className="text-gray-600">
                Founder-led with significant personal capital invested alongside partners in every deal, ensuring aligned interests and shared success.
              </p>
            </div>

            <div className="text-center">
              <div className="w-20 h-20 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center mx-auto mb-6">
                <FileText className="w-10 h-10 text-white" />
              </div>
              <h3 className="text-xl font-serif font-semibold text-primary mb-4">Full Transparency</h3>
              <p className="text-gray-600">
                Complete financial disclosure, regular performance updates, and direct access to the investment team throughout the entire investment lifecycle.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Investment Process / FAQ */}
      <section className="py-20 bg-gradient-to-br from-secondary to-gray-100" data-testid="faq-section">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-4">Investment Process</h2>
            <p className="text-xl text-gray-600">Common questions about our investment strategy and partnership opportunities</p>
          </div>

          <Accordion type="single" collapsible className="space-y-6" data-testid="faq-accordion">
            <AccordionItem value="strategy">
              <Card className="bg-white rounded-2xl card-shadow premium-border overflow-hidden">
                <AccordionTrigger className="p-6 hover:bg-gray-50 transition-colors duration-300 [&[data-state=open]]:bg-gray-50">
                  <h3 className="text-xl font-serif font-semibold text-primary text-left">What is your investment strategy?</h3>
                </AccordionTrigger>
                <AccordionContent className="px-6 pb-6">
                  <p className="text-gray-600 leading-relaxed">
                    We focus on value-add multifamily properties in emerging markets with strong rental demand. Our strategy involves acquiring underperforming assets, implementing strategic renovations and operational improvements, then either holding for cash flow or selling at optimized market timing.
                  </p>
                </AccordionContent>
              </Card>
            </AccordionItem>

            <AccordionItem value="financing">
              <Card className="bg-white rounded-2xl card-shadow premium-border overflow-hidden">
                <AccordionTrigger className="p-6 hover:bg-gray-50 transition-colors duration-300 [&[data-state=open]]:bg-gray-50">
                  <h3 className="text-xl font-serif font-semibold text-primary text-left">How do you finance your acquisitions?</h3>
                </AccordionTrigger>
                <AccordionContent className="px-6 pb-6">
                  <p className="text-gray-600 leading-relaxed">
                    We utilize a combination of conventional mortgages, private capital, and strategic partnerships. Typically, we secure 70-80% financing through traditional lenders and raise the remaining capital from qualified investors, allowing us to maintain strong equity positions while maximizing returns.
                  </p>
                </AccordionContent>
              </Card>
            </AccordionItem>

            <AccordionItem value="returns">
              <Card className="bg-white rounded-2xl card-shadow premium-border overflow-hidden">
                <AccordionTrigger className="p-6 hover:bg-gray-50 transition-colors duration-300 [&[data-state=open]]:bg-gray-50">
                  <h3 className="text-xl font-serif font-semibold text-primary text-left">What returns do you target?</h3>
                </AccordionTrigger>
                <AccordionContent className="px-6 pb-6">
                  <p className="text-gray-600 leading-relaxed">
                    Our target returns are 15-25% IRR with equity multiples of 2.0x-4.0x over a 3-7 year hold period. We've consistently exceeded these targets with an average IRR of 85.3% and equity multiples averaging 3.02x across our portfolio.
                  </p>
                </AccordionContent>
              </Card>
            </AccordionItem>

            <AccordionItem value="investment">
              <Card className="bg-white rounded-2xl card-shadow premium-border overflow-hidden">
                <AccordionTrigger className="p-6 hover:bg-gray-50 transition-colors duration-300 [&[data-state=open]]:bg-gray-50">
                  <h3 className="text-xl font-serif font-semibold text-primary text-left">Can I invest with 5Central Capital?</h3>
                </AccordionTrigger>
                <AccordionContent className="px-6 pb-6">
                  <p className="text-gray-600 leading-relaxed">
                    We work with accredited investors and institutional partners. Minimum investments typically start at $50,000 for individual deals. We provide detailed investment memorandums, regular performance updates, and maintain full transparency throughout the investment lifecycle.
                  </p>
                </AccordionContent>
              </Card>
            </AccordionItem>
          </Accordion>
        </div>
      </section>

      {/* Call to Action */}
      <section className="py-20 bg-white" data-testid="cta-section">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-6">Ready to Explore Opportunities?</h2>
          <p className="text-xl text-gray-600 mb-12 max-w-2xl mx-auto">
            Discover our current investment opportunities and learn about our founder's ambitious vision to build a $1 billion real estate portfolio by 2050.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-6 justify-center mb-16">
            <Link href="/portfolio">
              <Button 
                className="bg-gradient-to-r from-accent-gold to-bronze text-white px-10 py-4 rounded-lg font-semibold text-lg hover:shadow-lg transition-all duration-300 transform hover:-translate-y-1"
                data-testid="button-cta-portfolio"
              >
                View Current Portfolio
              </Button>
            </Link>
            <Link href="/founder">
              <Button 
                variant="outline"
                className="border-2 border-primary text-primary px-10 py-4 rounded-lg font-semibold text-lg hover:bg-primary hover:text-white transition-all duration-300"
                data-testid="button-cta-founder"
              >
                Meet Michael McElwee
              </Button>
            </Link>
          </div>

          <div className="grid md:grid-cols-3 gap-8 text-center">
            <div className="flex flex-col items-center">
              <Mail className="w-8 h-8 text-accent-gold mb-2" />
              <div className="text-2xl font-bold text-primary mb-2" data-testid="contact-email">info@5central.capital</div>
              <div className="text-gray-600">General Inquiries</div>
            </div>
            <div className="flex flex-col items-center">
              <Phone className="w-8 h-8 text-accent-gold mb-2" />
              <div className="text-2xl font-bold text-primary mb-2" data-testid="contact-phone">(813) 555-0100</div>
              <div className="text-gray-600">Investment Opportunities</div>
            </div>
            <div className="flex flex-col items-center">
              <MapPin className="w-8 h-8 text-accent-gold mb-2" />
              <div className="text-2xl font-bold text-primary mb-2" data-testid="contact-location">Tampa, FL</div>
              <div className="text-gray-600">Headquarters</div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-primary text-white py-16" data-testid="footer">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-4 gap-8">
            <div className="md:col-span-2">
              <div className="flex items-center mb-6">
                <img 
                  src="/attached_assets/Logo_1754933299875.JPG"
                  alt="5Central Capital Logo" 
                  className="h-16 object-contain"
                />
              </div>
              <p className="text-gray-300 leading-relaxed max-w-md">
                Strategic real estate investment firm specializing in high-return multifamily acquisitions with proven value creation through disciplined execution and strategic financing.
              </p>
            </div>

            <div>
              <h3 className="text-lg font-serif font-semibold mb-4">Navigation</h3>
              <ul className="space-y-2 text-gray-300">
                <li><Link href="/portfolio" className="hover:text-accent-gold transition-colors duration-300">Portfolio</Link></li>
                <li><Link href="/founder" className="hover:text-accent-gold transition-colors duration-300">Founder</Link></li>
                <li><Link href="/vision" className="hover:text-accent-gold transition-colors duration-300">Vision</Link></li>
              </ul>
            </div>

            <div>
              <h3 className="text-lg font-serif font-semibold mb-4">Contact</h3>
              <ul className="space-y-2 text-gray-300">
                <li>info@5central.capital</li>
                <li>(813) 555-0100</li>
                <li>Tampa, FL</li>
              </ul>
            </div>
          </div>

          <div className="border-t border-gray-700 mt-12 pt-8 text-center text-gray-400">
            <p>&copy; 2024 5Central Capital. All rights reserved. | Investment opportunities subject to qualification and availability.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
