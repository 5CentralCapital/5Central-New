import { useState } from "react";
import { type Property } from "@shared/schema";
import HeroSection from "@/components/hero-section";
import PropertyCard from "@/components/property-card";
import PropertyModal from "@/components/property-modal";
import GrowthModal from "@/components/growth-modal";
import PerformanceMetrics from "@/components/performance-metrics";
import {
  getPublicPropertyImage,
  publicAllProperties,
  publicCurrentProperties,
  publicPortfolioFacts,
  publicPortfolioPulse,
  publicSoldProperties,
} from "@/lib/public-portfolio-data";
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
  Maximize2
} from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

export default function Home() {
  const currentProperties = publicCurrentProperties;
  const soldProperties = publicSoldProperties;
  const allProperties = publicAllProperties;
  const featuredPropertyIds = new Set(["sun-cove-apartments", "lucia-apartments", "mlk-apartments"]);
  const featuredProperties = publicCurrentProperties.filter((property) => featuredPropertyIds.has(property.id));
  const [selectedProperty, setSelectedProperty] = useState<Property | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [growthModalOpen, setGrowthModalOpen] = useState(false);
  const [growthModalType, setGrowthModalType] = useState<'current' | 'future'>('current');

  const openGrowthModal = (type: 'current' | 'future') => {
    setGrowthModalType(type);
    setGrowthModalOpen(true);
  };

  const openPropertyModal = (property: Property) => {
    setSelectedProperty(property);
    setIsModalOpen(true);
  };

  const closePropertyModal = () => {
    setIsModalOpen(false);
    setSelectedProperty(null);
  };

  // Helper function to get IRR from property (handles both numeric irr and text irrLevered)
  const getPropertyIRR = (property: Property): number => {
    // First check irrLevered (text format like "40-50%") which is more commonly populated
    if (property.irrLevered) {
      const match = property.irrLevered.match(/(\d+)-(\d+)/);
      if (match) {
        return (parseFloat(match[1]) + parseFloat(match[2])) / 2;
      }
    }
    // Fall back to numeric irr field if it has a meaningful value
    if (property.irr && parseFloat(property.irr) > 0) {
      return parseFloat(property.irr);
    }
    return 0;
  };

  // Calculate metrics for CURRENT properties only (for hero section)
  const currentPortfolioValue = publicPortfolioFacts.publicAum;
  const currentUnits = publicPortfolioFacts.activeMultifamilyUnits;

  // Calculate metrics for ALL properties (current + sold) for performance metrics section
  const totalPortfolioValue = allProperties.reduce((sum, p) => {
    const value = parseFloat(p.currentValue || p.salePrice || "0");
    return sum + value;
  }, 0);

  const totalUnits = allProperties.reduce((sum, p) => sum + p.units, 0);

  const totalEquityCreated = allProperties.reduce((sum, p) => {
    const totalBasis = parseFloat(p.totalBasis || "0") || (parseFloat(p.acquisitionPrice) + parseFloat(p.rehabCosts || "0"));
    const currentValue = parseFloat(p.currentValue || p.salePrice || "0");
    return sum + Math.max(0, currentValue - totalBasis);
  }, 0);

  const avgReturn = soldProperties.length > 0
    ? soldProperties.reduce((sum, p) => sum + getPropertyIRR(p), 0) / soldProperties.length
    : 0;

  const avgEquityMultiple = soldProperties.length > 0 ? soldProperties.reduce((sum, p) => {
    const multiple = parseFloat(p.equityMultiple || "0");
    return sum + multiple;
  }, 0) / soldProperties.length : 0;

  const projectedAumGrowth = Math.round(
    (publicPortfolioFacts.projected2026Aum / publicPortfolioFacts.publicAum - 1) * 100,
  );

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
      title: "Real Operating Data",
      description: "Public AUM, occupancy, rent upside, and project profit are tied back to the operating workbooks."
    },
    {
      icon: Award,
      title: "Execution Proof",
      description: "Four active Florida multifamily assets, three small-project flips, and a documented exit track record."
    },
    {
      icon: Users,
      title: "Founder-Led",
      description: "No layers. Capital, rehab, leasing, refinancing, and reporting are run directly by the sponsor."
    },
    {
      icon: FileText,
      title: "Clean Reporting",
      description: "Investor materials are built from the same rent roll, rehab, debt, and cashflow files used to run the business."
    }
  ];

  return (
    <div className="min-h-screen bg-background" data-testid="home-page">
      <HeroSection
        totalPortfolioValue={currentPortfolioValue}
        totalUnits={currentUnits}
        yieldOnCost={publicPortfolioFacts.yieldOnCost}
        weightedCapRate={publicPortfolioFacts.weightedCapRate}
      />

      {/* Featured Properties */}
      <section id="portfolio" className="section-padding bg-background" data-testid="featured-properties-section">
        <div className="container-wide">
          <div className="text-center mb-16">
            <div className="divider mx-auto mb-6" />
            <h2 className="text-foreground mb-4">Featured Properties</h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Three core Florida multifamily assets, using verified workbook data and the larger photo library.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8 mb-12" data-testid="property-grid">
            {featuredProperties.map((property) => (
              <PropertyCard
                key={property.id}
                property={property}
                imageUrl={getPublicPropertyImage(property)}
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

      {/* Portfolio Pulse */}
      <section className="py-10 md:py-14 bg-soft-cream border-y border-border/50" data-testid="portfolio-pulse-section">
        <div className="container-wide">
          <div className="mb-8">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-px bg-warm-brass" />
                <span className="text-xs uppercase tracking-[0.2em] text-warm-brass font-medium">Portfolio Pulse</span>
              </div>
              <h2 className="text-foreground mb-2">Current Operating Snapshot</h2>
              <p className="text-muted-foreground max-w-xl">
                Contracted rent and occupancy are shown alongside the approved property underwriting.
              </p>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {publicPortfolioPulse.cards.map((card) => (
              <div key={card.label} className="bg-white border border-border/60 p-5">
                <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-3">{card.label}</div>
                <div className="font-serif text-2xl md:text-3xl text-warm-brass mb-1">{card.value}</div>
                <p className="text-xs text-muted-foreground">{card.sublabel}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ========================================
          GROWTH SNAPSHOT - COMPACT AUM-FOCUSED DESIGN
          ======================================== */}
      <section className="py-12 md:py-16 bg-soft-cream border-y border-border/50 relative">
        {/* Top accent line */}
        <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-warm-brass/40 to-transparent" />

        <div className="container-wide">
          {/* Compact Header */}
          <div className="flex items-center justify-center gap-4 mb-10">
            <div className="h-px w-12 bg-warm-brass/40" />
            <span className="text-warm-brass text-[11px] uppercase tracking-[0.3em] font-medium">
              Growth Trajectory
            </span>
            <div className="h-px w-12 bg-warm-brass/40" />
          </div>

          {/* Main Cards - Horizontal Rectangle Layout */}
          <div className="grid lg:grid-cols-11 gap-4 lg:gap-6 items-stretch">

            {/* LEFT: Current Portfolio - Compact Rectangle */}
            <div className="lg:col-span-5 group">
              <div
                className="h-full bg-white border border-border/60 p-6 md:p-8 relative overflow-hidden transition-all duration-300 hover:border-warm-brass/40 hover:shadow-lg cursor-pointer"
                onClick={() => openGrowthModal('current')}
              >
                {/* Expand icon */}
                <div className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center bg-soft-cream/90 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
                  <Maximize2 className="w-3.5 h-3.5 text-warm-brass" />
                </div>

                {/* Top Row: Label */}
                <div className="flex items-center gap-2 mb-5">
                  <div className="w-6 h-px bg-warm-brass" />
                  <span className="text-[10px] uppercase tracking-[0.25em] text-warm-brass font-medium">Today</span>
                </div>

                {/* AUM as Hero - Most Important */}
                <div className="mb-5">
                  <div className="font-serif text-4xl md:text-5xl lg:text-6xl text-warm-brass font-light tracking-tight mb-1">
                    {publicPortfolioFacts.publicAumLabel}
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Current AUM</div>
                </div>

                {/* Compact Metrics Row */}
                <div className="flex items-center gap-6 pt-4 border-t border-border/50">
                  <div>
                    <div className="font-serif text-2xl md:text-3xl text-foreground">{currentUnits}</div>
                    <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Units</div>
                  </div>
                  <div className="h-8 w-px bg-border/50" />
                  <div>
                    <div className="font-serif text-lg text-foreground">{currentProperties.length}</div>
                    <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Properties</div>
                  </div>
                  <div className="h-8 w-px bg-border/50" />
                  <div>
                    <div className="font-serif text-lg text-foreground">${(publicPortfolioFacts.portfolioEquity / 1_000_000).toFixed(2)}M</div>
                    <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Equity</div>
                  </div>
                </div>
              </div>
            </div>

            {/* CENTER: Arrow Connector - Minimal */}
            <div className="lg:col-span-1 flex items-center justify-center py-4 lg:py-0">
              <div className="w-10 h-10 rounded-full border-2 border-warm-brass flex items-center justify-center bg-white shadow-md">
                <ArrowRight className="w-4 h-4 text-warm-brass" />
              </div>
            </div>

            {/* RIGHT: 2026 Target - Compact Dark Rectangle */}
            <div className="lg:col-span-5 group">
              <div
                className="h-full bg-deep-charcoal text-white p-6 md:p-8 relative overflow-hidden transition-all duration-300 hover:shadow-xl cursor-pointer"
                onClick={() => openGrowthModal('future')}
              >
                {/* Subtle texture */}
                <div className="absolute inset-0 opacity-[0.02]" style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
                }} />
                {/* Top gold line */}
                <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-warm-brass to-transparent" />

                {/* Expand icon */}
                <div className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center bg-white/10 rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-10">
                  <Maximize2 className="w-3.5 h-3.5 text-warm-brass" />
                </div>

                {/* Top Row: Label + Growth Badge */}
                <div className="relative flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-px bg-warm-brass" />
                    <span className="text-[10px] uppercase tracking-[0.25em] text-warm-brass font-medium">Year-End 2026</span>
                  </div>
                  <div className="px-2.5 py-1 bg-emerald-500/20 border border-emerald-500/30 rounded-sm">
                    <span className="text-emerald-400 text-xs font-medium">+{projectedAumGrowth}% AUM</span>
                  </div>
                </div>

                {/* AUM as Hero - Most Important */}
                <div className="relative mb-5">
                  <div className="font-serif text-4xl md:text-5xl lg:text-6xl text-warm-brass font-light tracking-tight mb-1">
                    $23.76M
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">Projected AUM</div>
                </div>

                {/* Compact Metrics Row */}
                <div className="relative flex items-center gap-6 pt-4 border-t border-white/10">
                  <div>
                    <div className="font-serif text-2xl md:text-3xl text-white">124</div>
                    <div className="text-[9px] uppercase tracking-wider text-white/40">Units</div>
                  </div>
                  <div className="h-8 w-px bg-white/10" />
                  <div>
                    <div className="text-emerald-400 font-medium">+125%</div>
                    <div className="text-[9px] uppercase tracking-wider text-white/40">Growth</div>
                  </div>
                  <div className="h-8 w-px bg-white/10" />
                  <div>
                    <div className="text-emerald-400 font-medium">+200%</div>
                    <div className="text-[9px] uppercase tracking-wider text-white/40">Equity</div>
                  </div>
                </div>
              </div>
            </div>

          </div>

          {/* View Full Strategy Link */}
          <div className="text-center mt-8">
            <Link href="/portfolio">
              <Button className="btn-outline group">
                View Full Growth Strategy
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

      {/* Growth Modal */}
      <GrowthModal
        isOpen={growthModalOpen}
        onClose={() => setGrowthModalOpen(false)}
        type={growthModalType}
      />
    </div>
  );
}
