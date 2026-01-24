import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type Property } from "@shared/schema";
import HeroSection from "@/components/hero-section";
import PropertyCard from "@/components/property-card";
import PropertyModal from "@/components/property-modal";
import PerformanceMetrics from "@/components/performance-metrics";
import { getPropertyImage } from "@/lib/property-data";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import {
  CheckCircle,
  Award,
  Users,
  FileText,
  Mail,
  Phone,
  MapPin,
  ArrowRight,
  ChevronDown
} from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

export default function Home() {
  const { data: currentProperties = [], isLoading: currentLoading } = useQuery<Property[]>({
    queryKey: ["/api/properties/current"],
  });

  const { data: allProperties = [], isLoading: allLoading } = useQuery<Property[]>({
    queryKey: ["/api/properties"],
  });

  const [selectedProperty, setSelectedProperty] = useState<Property | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const openPropertyModal = (property: Property) => {
    setSelectedProperty(property);
    setIsModalOpen(true);
  };

  const closePropertyModal = () => {
    setIsModalOpen(false);
    setSelectedProperty(null);
  };

  const isLoading = currentLoading || allLoading;

  // Helper function to get IRR from property (handles both numeric irr and text irrLevered)
  const getPropertyIRR = (property: Property): number => {
    if (property.irr) {
      return parseFloat(property.irr);
    }
    if (property.irrLevered) {
      const match = property.irrLevered.match(/(\d+)-(\d+)/);
      if (match) {
        return (parseFloat(match[1]) + parseFloat(match[2])) / 2;
      }
    }
    return 0;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background" data-testid="loading-state">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-warm-brass border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground text-sm uppercase tracking-wider">Loading</p>
        </div>
      </div>
    );
  }

  // Calculate metrics for CURRENT properties only (for hero section)
  const currentPortfolioValue = currentProperties.reduce((sum, p) => {
    const value = parseFloat(p.currentValue || "0");
    return sum + value;
  }, 0);

  const currentUnits = currentProperties.reduce((sum, p) => sum + p.units, 0);

  const currentAvgReturn = currentProperties.length > 0
    ? currentProperties.reduce((sum, p) => sum + getPropertyIRR(p), 0) / currentProperties.length
    : 0;

  const currentAvgEquityMultiple = currentProperties.length > 0 ? currentProperties.reduce((sum, p) => {
    const multiple = parseFloat(p.equityMultiple || "0");
    return sum + multiple;
  }, 0) / currentProperties.length : 0;

  // Calculate metrics for ALL properties (current + sold) for performance metrics section
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

  const avgReturn = allProperties.length > 0
    ? allProperties.reduce((sum, p) => sum + getPropertyIRR(p), 0) / allProperties.length
    : 0;

  const avgEquityMultiple = allProperties.length > 0 ? allProperties.reduce((sum, p) => {
    const multiple = parseFloat(p.equityMultiple || "0");
    return sum + multiple;
  }, 0) / allProperties.length : 0;

  const totalRealizedProfits = soldProperties.reduce((sum, p) => {
    const acquisitionPrice = parseFloat(p.acquisitionPrice);
    const salePrice = parseFloat(p.salePrice || "0");
    return sum + Math.max(0, salePrice - acquisitionPrice);
  }, 0);

  const ctUnits = allProperties.filter(p => p.state === 'CT').reduce((sum, p) => sum + p.units, 0);
  const flUnits = allProperties.filter(p => p.state === 'FL').reduce((sum, p) => sum + p.units, 0);

  const features = [
    {
      icon: CheckCircle,
      title: "Exceptional Returns",
      description: "Consistently deliver 3.0x+ equity multiples through strategic value-add renovations and operational improvements."
    },
    {
      icon: Award,
      title: "Proven Track Record",
      description: "Successfully acquired 47 units across 13 properties with documented performance metrics and transparent reporting."
    },
    {
      icon: Users,
      title: "Principal Investment",
      description: "Founder-led with significant personal capital invested alongside partners in every deal."
    },
    {
      icon: FileText,
      title: "Full Transparency",
      description: "Complete financial disclosure and direct access to the investment team throughout the lifecycle."
    }
  ];

  return (
    <div className="min-h-screen bg-background" data-testid="home-page">
      <HeroSection
        totalPortfolioValue={currentPortfolioValue}
        totalUnits={currentUnits}
        avgEquityMultiple={currentAvgEquityMultiple}
        avgReturn={currentAvgReturn}
      />

      {/* Featured Properties */}
      <section id="portfolio" className="section-padding bg-background" data-testid="featured-properties-section">
        <div className="container-wide">
          <div className="text-center mb-16">
            <div className="divider mx-auto mb-6" />
            <h2 className="text-foreground mb-4">Featured Properties</h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Current multifamily investments showcasing our value-add strategy with verified performance metrics
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8 mb-12" data-testid="property-grid">
            {currentProperties.slice(0, 3).map((property) => (
              <PropertyCard
                key={property.id}
                property={property}
                imageUrl={getPropertyImage(property.name)}
                onClick={() => openPropertyModal(property)}
              />
            ))}
          </div>

          <div className="text-center">
            <Link href="/portfolio">
              <Button
                className="btn-outline group"
                data-testid="button-view-complete-portfolio"
              >
                View Complete Portfolio
                <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
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
        ctUnits={ctUnits}
        flUnits={flUnits}
      />

      {/* Why Partner With Us */}
      <section className="section-padding bg-background" data-testid="why-partner-section">
        <div className="container-wide">
          <div className="text-center mb-16">
            <div className="divider mx-auto mb-6" />
            <h2 className="text-foreground mb-4">Why Partner With Us</h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Our methodology combines aggressive value creation with strategic financing to deliver industry-leading returns.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
            {features.map((feature, index) => (
              <div key={index} className="group">
                <div className="mb-6">
                  <div className="w-12 h-12 flex items-center justify-center border border-border group-hover:border-warm-brass/50 transition-colors duration-300">
                    <feature.icon className="w-5 h-5 text-warm-brass" />
                  </div>
                </div>
                <h3 className="text-lg font-serif font-medium text-foreground mb-3">
                  {feature.title}
                </h3>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Investment Process / FAQ */}
      <section className="section-padding bg-soft-cream" data-testid="faq-section">
        <div className="max-w-3xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-16">
            <div className="divider mx-auto mb-6" />
            <h2 className="text-foreground mb-4">Investment Process</h2>
            <p className="text-lg text-muted-foreground">
              Common questions about our strategy and partnership opportunities
            </p>
          </div>

          <Accordion type="single" collapsible className="space-y-4" data-testid="faq-accordion">
            <AccordionItem value="strategy" className="border border-border bg-card">
              <AccordionTrigger className="px-6 py-5 hover:no-underline group">
                <span className="text-left font-serif text-lg font-medium text-foreground group-hover:text-warm-brass transition-colors">
                  What is your investment strategy?
                </span>
              </AccordionTrigger>
              <AccordionContent className="px-6 pb-6 pt-0">
                <p className="text-muted-foreground leading-relaxed">
                  We focus on value-add multifamily properties in emerging markets with strong rental demand. Our strategy involves acquiring underperforming assets, implementing strategic renovations and operational improvements, then either holding for cash flow or selling at optimized market timing.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="financing" className="border border-border bg-card">
              <AccordionTrigger className="px-6 py-5 hover:no-underline group">
                <span className="text-left font-serif text-lg font-medium text-foreground group-hover:text-warm-brass transition-colors">
                  How do you finance acquisitions?
                </span>
              </AccordionTrigger>
              <AccordionContent className="px-6 pb-6 pt-0">
                <p className="text-muted-foreground leading-relaxed">
                  We utilize a combination of conventional mortgages, private capital, and strategic partnerships. Typically, we secure 70-80% financing through traditional lenders and raise the remaining capital from qualified investors.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="returns" className="border border-border bg-card">
              <AccordionTrigger className="px-6 py-5 hover:no-underline group">
                <span className="text-left font-serif text-lg font-medium text-foreground group-hover:text-warm-brass transition-colors">
                  What returns do you target?
                </span>
              </AccordionTrigger>
              <AccordionContent className="px-6 pb-6 pt-0">
                <p className="text-muted-foreground leading-relaxed">
                  Our target returns are 15-25% IRR with equity multiples of 2.0x-4.0x over a 3-7 year hold period. We've consistently exceeded these targets with an average IRR of {avgReturn.toFixed(1)}% and equity multiples averaging {avgEquityMultiple.toFixed(2)}x across our portfolio.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="investment" className="border border-border bg-card">
              <AccordionTrigger className="px-6 py-5 hover:no-underline group">
                <span className="text-left font-serif text-lg font-medium text-foreground group-hover:text-warm-brass transition-colors">
                  Can I invest with 5Central Capital?
                </span>
              </AccordionTrigger>
              <AccordionContent className="px-6 pb-6 pt-0">
                <p className="text-muted-foreground leading-relaxed">
                  We work with accredited investors and institutional partners. Minimum investments typically start at $50,000 for individual deals. We provide detailed investment memorandums and maintain full transparency throughout the investment lifecycle.
                </p>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </section>

      {/* Call to Action */}
      <section className="section-padding bg-deep-charcoal text-white" data-testid="cta-section">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <div className="divider mx-auto mb-6 bg-warm-brass" />
          <h2 className="text-white mb-6">Ready to Explore Opportunities?</h2>
          <p className="text-xl text-white/70 mb-12 max-w-2xl mx-auto font-light">
            Discover our current investment opportunities and learn about our vision to build a $1 billion real estate portfolio.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-20">
            <Link href="/portfolio">
              <Button
                className="btn-accent"
                data-testid="button-cta-portfolio"
              >
                View Portfolio
              </Button>
            </Link>
            <Link href="/founder">
              <Button
                className="btn-outline border-white/30 text-white hover:bg-white hover:text-deep-charcoal"
                data-testid="button-cta-founder"
              >
                Meet the Founder
              </Button>
            </Link>
          </div>

          <div className="grid md:grid-cols-3 gap-12 pt-12 border-t border-white/10">
            <div className="text-center">
              <Mail className="w-5 h-5 text-warm-brass mx-auto mb-3" />
              <div className="text-lg font-medium text-white mb-1" data-testid="contact-email">michael@5central.capital</div>
              <div className="text-sm text-white/50 uppercase tracking-wider">General Inquiries</div>
            </div>
            <div className="text-center">
              <Phone className="w-5 h-5 text-warm-brass mx-auto mb-3" />
              <div className="text-lg font-medium text-white mb-1" data-testid="contact-phone">860-326-6094</div>
              <div className="text-sm text-white/50 uppercase tracking-wider">Investment Line</div>
            </div>
            <div className="text-center">
              <MapPin className="w-5 h-5 text-warm-brass mx-auto mb-3" />
              <div className="text-lg font-medium text-white mb-1" data-testid="contact-location">Tampa, FL</div>
              <div className="text-sm text-white/50 uppercase tracking-wider">Headquarters</div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-16 bg-background border-t border-border" data-testid="footer">
        <div className="container-wide">
          <div className="grid md:grid-cols-3 gap-12 mb-12">
            <div>
              <div className="font-serif text-xl tracking-tight mb-4">
                <span className="font-medium">5Central</span>
                <span className="text-warm-brass ml-1 italic">Capital</span>
              </div>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Strategic real estate investment firm specializing in high-return multifamily acquisitions with proven value creation.
              </p>
            </div>

            <div>
              <h4 className="text-sm uppercase tracking-wider text-muted-foreground mb-4">Navigation</h4>
              <ul className="space-y-3">
                <li>
                  <Link href="/portfolio" className="text-foreground hover:text-warm-brass transition-colors text-sm">
                    Portfolio
                  </Link>
                </li>
                <li>
                  <Link href="/founder" className="text-foreground hover:text-warm-brass transition-colors text-sm">
                    Founder
                  </Link>
                </li>
                <li>
                  <Link href="/vision" className="text-foreground hover:text-warm-brass transition-colors text-sm">
                    Vision
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <h4 className="text-sm uppercase tracking-wider text-muted-foreground mb-4">Contact</h4>
              <ul className="space-y-3 text-sm text-foreground">
                <li>michael@5central.capital</li>
                <li>860-326-6094</li>
                <li>Tampa, FL</li>
              </ul>
            </div>
          </div>

          <div className="pt-8 border-t border-border text-center">
            <p className="text-sm text-muted-foreground">
              &copy; {new Date().getFullYear()} 5Central Capital. All rights reserved.
            </p>
          </div>
        </div>
      </footer>

      {/* Property Modal */}
      <PropertyModal
        property={selectedProperty}
        isOpen={isModalOpen}
        onClose={closePropertyModal}
      />
    </div>
  );
}
