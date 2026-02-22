import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type Property } from "@shared/schema";
import PropertyCard from "@/components/property-card";
import PropertyModal from "@/components/property-modal";
import GrowthModal from "@/components/growth-modal";
import PerformanceMetrics from "@/components/performance-metrics";
import { getPropertyImage } from "@/lib/property-data";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import {
  MapPin,
  Building2,
  Mail,
  Phone,
  Calendar,
  ArrowRight,
  TrendingUp,
  Target,
  Award,
  Maximize2
} from "lucide-react";

export default function Portfolio() {
  const { data: currentProperties = [], isLoading: currentLoading } = useQuery<Property[]>({
    queryKey: ["/api/properties/current"],
  });

  const { data: soldProperties = [], isLoading: soldLoading } = useQuery<Property[]>({
    queryKey: ["/api/properties/sold"],
  });

  const { data: allProperties = [], isLoading: allLoading } = useQuery<Property[]>({
    queryKey: ["/api/properties"],
  });

  const [selectedProperty, setSelectedProperty] = useState<Property | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'all' | 'current' | 'sold'>('all');
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

  const isLoading = currentLoading || soldLoading || allLoading;

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

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center pt-16 bg-background" data-testid="portfolio-loading">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-warm-brass border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground text-sm uppercase tracking-wider">Loading Portfolio</p>
        </div>
      </div>
    );
  }

  // Calculate metrics
  const currentPortfolioValue = currentProperties.reduce((sum, p) => sum + parseFloat(p.currentValue || "0"), 0);
  const currentUnits = currentProperties.reduce((sum, p) => sum + p.units, 0);

  const totalPortfolioValue = allProperties.reduce((sum, p) => sum + parseFloat(p.currentValue || p.salePrice || "0"), 0);
  const totalUnits = allProperties.reduce((sum, p) => sum + p.units, 0);

  const totalEquityCreated = allProperties.reduce((sum, p) => {
    const totalBasis = parseFloat(p.totalBasis || "0") || (parseFloat(p.acquisitionPrice) + parseFloat(p.rehabCosts || "0"));
    const currentValue = parseFloat(p.currentValue || p.salePrice || "0");
    return sum + Math.max(0, currentValue - totalBasis);
  }, 0);

  const avgReturn = allProperties.length > 0
    ? allProperties.reduce((sum, p) => sum + getPropertyIRR(p), 0) / allProperties.length
    : 0;

  const avgEquityMultiple = allProperties.length > 0
    ? allProperties.reduce((sum, p) => sum + parseFloat(p.equityMultiple || "0"), 0) / allProperties.length
    : 0;

  const totalRealizedProfits = soldProperties.reduce((sum, p) => {
    const acquisitionPrice = parseFloat(p.acquisitionPrice);
    const salePrice = parseFloat(p.salePrice || "0");
    return sum + Math.max(0, salePrice - acquisitionPrice);
  }, 0);

  const ctProperties = allProperties.filter(p => p.state === 'CT');
  const flProperties = allProperties.filter(p => p.state === 'FL');
  const ctUnits = ctProperties.reduce((sum, p) => sum + p.units, 0);
  const flUnits = flProperties.reduce((sum, p) => sum + p.units, 0);

  return (
    <div className="min-h-screen bg-background" data-testid="portfolio-page">
      {/* ========================================
          PORTFOLIO HEADER - COMPACT & DISTINCT
          ======================================== */}
      <section className="portfolio-header bg-background pt-28 pb-16 border-b border-border relative">
        <div className="container-wide">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-20 items-center">
            {/* Left: Title and description */}
            <div>
              <div className="inline-flex items-center gap-3 mb-6 px-4 py-2 bg-soft-cream border border-border">
                <span className="w-2 h-2 bg-warm-brass rounded-full" />
                <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-medium">Portfolio Overview</span>
              </div>

              <h1 className="text-foreground mb-6" data-testid="portfolio-title">
                Investment <span className="text-warm-brass italic">Portfolio</span>
              </h1>

              <p className="text-lg text-muted-foreground max-w-lg leading-relaxed">
                Track record of multifamily acquisitions across Connecticut and Florida with documented performance metrics.
              </p>
            </div>

            {/* Right: Stat blocks in horizontal row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" data-testid="portfolio-overview-stats">
              <div className="stat-block">
                <div className="stat-block-value" data-testid="stat-current-value">
                  ${(currentPortfolioValue / 1000000).toFixed(1)}M
                </div>
                <div className="stat-block-label">AUM</div>
              </div>
              <div className="stat-block">
                <div className="stat-block-value" data-testid="stat-properties">
                  {currentProperties.length}
                </div>
                <div className="stat-block-label">Active Properties</div>
              </div>
              <div className="stat-block">
                <div className="stat-block-value" data-testid="stat-units">
                  {currentUnits}
                </div>
                <div className="stat-block-label">Total Units</div>
              </div>
              <div className="stat-block">
                <div className="stat-block-value" data-testid="stat-multiple">
                  {avgEquityMultiple.toFixed(2)}x
                </div>
                <div className="stat-block-label">Avg Multiple</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ========================================
          PORTFOLIO SNAPSHOT - COMPACT AUM-FOCUSED DESIGN
          ======================================== */}
      <section className="py-12 md:py-16 bg-soft-cream border-b border-border/50 relative">
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

                {/* Top Row: Label + AUM Hero */}
                <div className="flex items-start justify-between mb-5">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-px bg-warm-brass" />
                    <span className="text-[10px] uppercase tracking-[0.25em] text-warm-brass font-medium">Today</span>
                  </div>
                </div>

                {/* AUM as Hero - Most Important */}
                <div className="mb-5">
                  <div className="font-serif text-4xl md:text-5xl lg:text-6xl text-warm-brass font-light tracking-tight mb-1">
                    ${(currentPortfolioValue / 1000000).toFixed(2)}M
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
                    <div className="font-serif text-lg text-foreground">$630K</div>
                    <div className="text-[9px] uppercase tracking-wider text-muted-foreground">NOI</div>
                  </div>
                  <div className="h-8 w-px bg-border/50" />
                  <div>
                    <div className="font-serif text-lg text-foreground">$3.87M</div>
                    <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Equity</div>
                  </div>
                  <div className="h-8 w-px bg-border/50" />
                  <div>
                    <div className="font-serif text-lg text-foreground">10.3%</div>
                    <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Yield</div>
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
                    <span className="text-emerald-400 text-xs font-medium">+147% AUM</span>
                  </div>
                </div>

                {/* AUM as Hero - Most Important */}
                <div className="relative mb-5">
                  <div className="font-serif text-4xl md:text-5xl lg:text-6xl text-warm-brass font-light tracking-tight mb-1">
                    $23.76M
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">Projected AUM</div>
                </div>

                {/* Compact Metrics + Milestones Row */}
                <div className="relative flex items-start gap-6 pt-4 border-t border-white/10">
                  {/* Left: Key metrics */}
                  <div className="flex items-center gap-5">
                    <div>
                      <div className="font-serif text-2xl md:text-3xl text-white">124</div>
                      <div className="text-[9px] uppercase tracking-wider text-white/40">Units</div>
                    </div>
                    <div className="h-8 w-px bg-white/10" />
                    <div>
                      <div className="text-emerald-400 font-medium">+125%</div>
                      <div className="text-[9px] uppercase tracking-wider text-white/40">Growth</div>
                    </div>
                  </div>
                  {/* Right: Next milestone */}
                  <div className="ml-auto text-right">
                    <div className="text-warm-brass text-sm font-medium">Jun 2026</div>
                    <div className="text-[9px] uppercase tracking-wider text-white/40">Next Milestone</div>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ========================================
          PROPERTY PORTFOLIO SECTION
          ======================================== */}
      <section className="section-padding bg-background relative">
        <div className="container-wide">
          {/* Section header */}
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6 mb-10">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-px bg-warm-brass" />
                <span className="text-xs uppercase tracking-[0.2em] text-warm-brass font-medium">Portfolio</span>
              </div>
              <h2 className="text-foreground mb-2">Property Collection</h2>
              <p className="text-lg text-muted-foreground max-w-xl">
                Complete portfolio including active investments and successful exits with verified performance metrics.
              </p>
            </div>

            {/* Elegant tab navigation */}
            <div className="tabs-elegant" data-testid="portfolio-tabs">
              <button
                className={`tab-elegant ${activeTab === 'all' ? 'bg-warm-brass text-deep-charcoal' : ''}`}
                onClick={() => setActiveTab('all')}
                data-state={activeTab === 'all' ? 'active' : 'inactive'}
                data-testid="tab-all-properties"
              >
                All<sup>{allProperties.length}</sup>
              </button>
              <button
                className={`tab-elegant ${activeTab === 'current' ? 'bg-warm-brass text-deep-charcoal' : ''}`}
                onClick={() => setActiveTab('current')}
                data-state={activeTab === 'current' ? 'active' : 'inactive'}
                data-testid="tab-current-properties"
              >
                Current<sup>{currentProperties.length}</sup>
              </button>
              <button
                className={`tab-elegant ${activeTab === 'sold' ? 'bg-warm-brass text-deep-charcoal' : ''}`}
                onClick={() => setActiveTab('sold')}
                data-state={activeTab === 'sold' ? 'active' : 'inactive'}
                data-testid="tab-sold-properties"
              >
                Exits<sup>{soldProperties.length}</sup>
              </button>
            </div>
          </div>

          {/* ALL PROPERTIES TAB */}
          {activeTab === 'all' && (
            <div data-testid="all-properties-content">
              {/* Current Holdings */}
              <div className="mb-12 relative">
                {/* Watermark text */}
                <div className="text-watermark -left-8 top-0">Current</div>

                <div className="relative z-10">
                  <div className="flex items-center gap-4 mb-6">
                    <div className="w-10 h-10 flex items-center justify-center border border-warm-brass/30">
                      <Building2 className="w-5 h-5 text-warm-brass" />
                    </div>
                    <div>
                      <h3 className="text-2xl font-serif font-medium text-foreground">Current Holdings</h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        {currentProperties.length} active properties generating consistent returns
                      </p>
                    </div>
                  </div>

                  {/* Collage Grid for Current Properties */}
                  <div className="collage-grid">
                    {currentProperties.map((property, index) => {
                      // Assign collage positions based on index
                      const positions = ['collage-hero', 'collage-tall', 'collage-wide', 'collage-standard', 'collage-standard'];
                      const position = positions[index % positions.length];

                      return (
                        <div
                          key={property.id}
                          className={`collage-item ${position} group cursor-pointer`}
                          onClick={() => openPropertyModal(property)}
                        >
                          <div className="collage-image">
                            <img
                              src={getPropertyImage(property.name)}
                              alt={property.name}
                              className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                            />
                            <div className="collage-overlay" />
                            <div className="collage-content">
                              <div className="collage-tag">
                                <span>{property.units} Units</span>
                              </div>
                              <h4 className="collage-title">{property.name}</h4>
                              <p className="collage-location">
                                <MapPin className="w-3 h-3" />
                                {property.city}, {property.state}
                              </p>
                              <div className="collage-stats">
                                <span>${(parseFloat(property.currentValue || '0') / 1000000).toFixed(1)}M</span>
                                <span className="collage-divider">|</span>
                                <span>{property.irrLevered || `${getPropertyIRR(property).toFixed(0)}%`} IRR</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Divider */}
              <div className="section-separator" />

              {/* Sold Properties - Collage Style */}
              <div className="relative">
                <div className="flex items-center gap-4 mb-6">
                  <div className="w-10 h-10 flex items-center justify-center border border-warm-brass/30">
                    <Award className="w-5 h-5 text-warm-brass" />
                  </div>
                  <div>
                    <h3 className="text-2xl font-serif font-medium text-foreground">Successful Exits</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      {soldProperties.length} realized investments with ${(totalRealizedProfits / 1000).toFixed(0)}K in total profits
                    </p>
                  </div>
                </div>

                {/* Collage Grid for Sold Properties */}
                <div className="sold-collage-grid">
                  {soldProperties.map((property, index) => {
                    const buyPrice = parseFloat(property.acquisitionPrice);
                    const sellPrice = parseFloat(property.salePrice || '0');
                    const profit = sellPrice - buyPrice;
                    const returnPct = ((sellPrice - buyPrice) / buyPrice * 100).toFixed(0);

                    // Alternate between wide and standard
                    const isWide = index === 0;

                    return (
                      <div
                        key={property.id}
                        className={`sold-collage-item ${isWide ? 'sold-collage-wide' : ''} group cursor-pointer`}
                        onClick={() => openPropertyModal(property)}
                      >
                        <div className="sold-collage-image">
                          <img
                            src={getPropertyImage(property.name)}
                            alt={property.name}
                            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                          />
                          <div className="sold-collage-overlay" />
                          <Badge className="sold-collage-badge">
                            +{returnPct}% Return
                          </Badge>
                          <div className="sold-collage-content">
                            <h4 className="sold-collage-title">{property.name}</h4>
                            <p className="sold-collage-location">
                              <MapPin className="w-3 h-3" />
                              {property.city}, {property.state}
                            </p>
                            <div className="sold-collage-metrics">
                              <div className="sold-metric">
                                <span className="sold-metric-label">Acquired</span>
                                <span className="sold-metric-value">${(buyPrice / 1000).toFixed(0)}K</span>
                              </div>
                              <div className="sold-metric-arrow">→</div>
                              <div className="sold-metric">
                                <span className="sold-metric-label">Sold</span>
                                <span className="sold-metric-value text-warm-brass">${(sellPrice / 1000).toFixed(0)}K</span>
                              </div>
                              <div className="sold-metric profit">
                                <span className="sold-metric-label">Profit</span>
                                <span className="sold-metric-value text-green-400">+${(profit / 1000).toFixed(0)}K</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* CURRENT PROPERTIES TAB */}
          {activeTab === 'current' && (
            <div data-testid="current-properties-content">
              {/* Summary Panel */}
              <div className="panel-summary p-6 md:p-8 mb-8">
                <div className="flex items-center gap-3 mb-6">
                  <Target className="w-5 h-5 text-warm-brass" />
                  <h3 className="text-xl font-serif font-medium text-foreground">Current Holdings Overview</h3>
                </div>
                <div className="grid md:grid-cols-3 gap-6">
                  <div className="text-center md:text-left">
                    <div className="text-2xl md:text-3xl font-serif font-medium text-warm-brass mb-1" data-testid="current-total-value">
                      ${(currentProperties.reduce((sum, p) => sum + parseFloat(p.currentValue || "0"), 0) / 1000000).toFixed(2)}M
                    </div>
                    <div className="text-sm text-muted-foreground">Current Portfolio Value</div>
                    <div className="stat-bar mt-3">
                      <div className="stat-bar-fill" style={{ width: '85%' }} />
                    </div>
                  </div>
                  <div className="text-center md:border-x md:border-border md:px-8">
                    <div className="text-2xl md:text-3xl font-serif font-medium text-warm-brass mb-1" data-testid="current-total-units">
                      {currentProperties.reduce((sum, p) => sum + p.units, 0)}
                    </div>
                    <div className="text-sm text-muted-foreground">Active Units</div>
                    <div className="stat-bar mt-3">
                      <div className="stat-bar-fill" style={{ width: '70%' }} />
                    </div>
                  </div>
                  <div className="text-center md:text-right">
                    <div className="text-2xl md:text-3xl font-serif font-medium text-warm-brass mb-1" data-testid="current-avg-irr">
                      {(currentProperties.reduce((sum, p) => sum + getPropertyIRR(p), 0) / currentProperties.length).toFixed(1)}%
                    </div>
                    <div className="text-sm text-muted-foreground">Avg Projected IRR</div>
                    <div className="stat-bar mt-3">
                      <div className="stat-bar-fill" style={{ width: '92%' }} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Collage Grid for Current Properties */}
              <div className="collage-grid">
                {currentProperties.map((property, index) => {
                  const positions = ['collage-hero', 'collage-tall', 'collage-wide', 'collage-standard', 'collage-standard'];
                  const position = positions[index % positions.length];

                  return (
                    <div
                      key={property.id}
                      className={`collage-item ${position} group cursor-pointer`}
                      onClick={() => openPropertyModal(property)}
                    >
                      <div className="collage-image">
                        <img
                          src={getPropertyImage(property.name)}
                          alt={property.name}
                          className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                        />
                        <div className="collage-overlay" />
                        <div className="collage-content">
                          <div className="collage-tag">
                            <span>{property.units} Units</span>
                          </div>
                          <h4 className="collage-title">{property.name}</h4>
                          <p className="collage-location">
                            <MapPin className="w-3 h-3" />
                            {property.city}, {property.state}
                          </p>
                          <div className="collage-stats">
                            <span>${(parseFloat(property.currentValue || '0') / 1000000).toFixed(1)}M</span>
                            <span className="collage-divider">|</span>
                            <span>{property.irrLevered || `${getPropertyIRR(property).toFixed(0)}%`} IRR</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* SOLD PROPERTIES TAB */}
          {activeTab === 'sold' && (
            <div data-testid="sold-properties-content">
              {/* Summary Panel */}
              <div className="panel-summary p-6 md:p-8 mb-8">
                <div className="flex items-center gap-3 mb-6">
                  <TrendingUp className="w-5 h-5 text-warm-brass" />
                  <h3 className="text-lg font-serif font-medium text-foreground">Exits Overview</h3>
                </div>
                <div className="grid md:grid-cols-3 gap-6">
                  <div className="text-center md:text-left">
                    <div className="text-2xl md:text-3xl font-serif font-medium text-warm-brass mb-1" data-testid="sold-total-profits">
                      ${(totalRealizedProfits / 1000).toFixed(0)}K
                    </div>
                    <div className="text-sm text-muted-foreground">Total Realized Profits</div>
                    <div className="stat-bar mt-3">
                      <div className="stat-bar-fill" style={{ width: '78%' }} />
                    </div>
                  </div>
                  <div className="text-center md:border-x md:border-border md:px-8">
                    <div className="text-2xl md:text-3xl font-serif font-medium text-warm-brass mb-1" data-testid="sold-avg-multiple">
                      {(soldProperties.reduce((sum, p) => sum + parseFloat(p.equityMultiple || "0"), 0) / soldProperties.length).toFixed(2)}x
                    </div>
                    <div className="text-sm text-muted-foreground">Avg Equity Multiple</div>
                    <div className="stat-bar mt-3">
                      <div className="stat-bar-fill" style={{ width: '88%' }} />
                    </div>
                  </div>
                  <div className="text-center md:text-right">
                    <div className="text-2xl md:text-3xl font-serif font-medium text-warm-brass mb-1" data-testid="sold-avg-hold-period">
                      {(soldProperties.reduce((sum, p) => sum + parseFloat(p.yearsHeld || "0"), 0) / soldProperties.length).toFixed(1)}
                    </div>
                    <div className="text-sm text-muted-foreground">Avg Hold Period (Years)</div>
                    <div className="stat-bar mt-3">
                      <div className="stat-bar-fill" style={{ width: '65%' }} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Collage Grid for Sold Properties */}
              <div className="sold-collage-grid">
                {soldProperties.map((property, index) => {
                  const buyPrice = parseFloat(property.acquisitionPrice);
                  const sellPrice = parseFloat(property.salePrice || '0');
                  const profit = sellPrice - buyPrice;
                  const returnPct = ((sellPrice - buyPrice) / buyPrice * 100).toFixed(0);
                  const isWide = index === 0;

                  return (
                    <div
                      key={property.id}
                      className={`sold-collage-item ${isWide ? 'sold-collage-wide' : ''} group cursor-pointer`}
                      onClick={() => openPropertyModal(property)}
                    >
                      <div className="sold-collage-image">
                        <img
                          src={getPropertyImage(property.name)}
                          alt={property.name}
                          className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                        />
                        <div className="sold-collage-overlay" />
                        <Badge className="sold-collage-badge">
                          +{returnPct}% Return
                        </Badge>
                        <div className="sold-collage-content">
                          <h4 className="sold-collage-title">{property.name}</h4>
                          <p className="sold-collage-location">
                            <MapPin className="w-3 h-3" />
                            {property.city}, {property.state}
                          </p>
                          <div className="sold-collage-metrics">
                            <div className="sold-metric">
                              <span className="sold-metric-label">Acquired</span>
                              <span className="sold-metric-value">${(buyPrice / 1000).toFixed(0)}K</span>
                            </div>
                            <div className="sold-metric-arrow">→</div>
                            <div className="sold-metric">
                              <span className="sold-metric-label">Sold</span>
                              <span className="sold-metric-value text-warm-brass">${(sellPrice / 1000).toFixed(0)}K</span>
                            </div>
                            <div className="sold-metric profit">
                              <span className="sold-metric-label">Profit</span>
                              <span className="sold-metric-value text-green-400">+${(profit / 1000).toFixed(0)}K</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ========================================
          GROWTH STORY - COMPACT TIMELINE DESIGN
          ======================================== */}
      <section className="py-14 md:py-20 bg-soft-cream border-y border-border/30 relative">
        <div className="container-wide">
          {/* Compact Header */}
          <div className="text-center mb-10">
            <div className="flex items-center justify-center gap-4 mb-4">
              <div className="h-px w-10 bg-warm-brass/40" />
              <span className="text-warm-brass text-[10px] uppercase tracking-[0.3em] font-medium">
                Growth Strategy
              </span>
              <div className="h-px w-10 bg-warm-brass/40" />
            </div>
            <h2 className="font-serif text-2xl md:text-3xl text-foreground font-normal tracking-tight">
              The Path Forward
            </h2>
          </div>

          {/* Compact Comparison Bar */}
          <div className="bg-white border border-border/60 p-5 md:p-6 mb-10">
            <div className="flex flex-col md:flex-row items-center justify-between gap-6">
              {/* Today */}
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-5 h-px bg-warm-brass" />
                  <span className="text-[9px] uppercase tracking-[0.2em] text-warm-brass font-medium">Today</span>
                </div>
                <div className="font-serif text-3xl md:text-4xl text-warm-brass">$9.63M</div>
                <div className="text-muted-foreground text-sm">55 units</div>
              </div>

              {/* Arrow */}
              <div className="flex items-center gap-3">
                <div className="h-px w-8 bg-gradient-to-r from-warm-brass/30 to-warm-brass hidden md:block" />
                <div className="w-8 h-8 rounded-full border border-warm-brass flex items-center justify-center bg-white">
                  <ArrowRight className="w-3.5 h-3.5 text-warm-brass" />
                </div>
                <div className="h-px w-8 bg-gradient-to-r from-warm-brass to-warm-brass/30 hidden md:block" />
              </div>

              {/* 2026 */}
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-5 h-px bg-warm-brass" />
                  <span className="text-[9px] uppercase tracking-[0.2em] text-warm-brass font-medium">2026</span>
                </div>
                <div className="font-serif text-3xl md:text-4xl text-foreground">$23.76M</div>
                <div className="text-muted-foreground text-sm">124 units</div>
                <div className="px-2 py-1 bg-emerald-50 border border-emerald-200 rounded-sm">
                  <span className="text-emerald-600 text-xs font-medium">+147%</span>
                </div>
              </div>
            </div>
          </div>

          {/* Compact Milestone Cards */}
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { title: 'Rehab Completion', date: 'Jun', desc: 'Sun Cove & Lucia to 95% occ.', Icon: Building2 },
              { title: 'Strategic Refi', date: 'Aug', desc: '$843K equity release', Icon: TrendingUp },
              { title: 'Acquisition #1', date: 'Aug', desc: '40-unit property', Icon: Target },
              { title: 'Acquisition #2', date: 'Nov', desc: '40-unit to reach goal', Icon: Award },
            ].map((m, i) => (
              <div key={i} className="bg-white border border-border/60 p-5 hover:border-warm-brass/40 hover:shadow-md transition-all group">
                <div className="flex items-start justify-between mb-3">
                  <div className="w-9 h-9 flex items-center justify-center border border-warm-brass/20 bg-warm-brass/5 group-hover:bg-warm-brass/10 transition-colors">
                    <m.Icon className="w-4 h-4 text-warm-brass" />
                  </div>
                  <span className="text-[10px] uppercase tracking-wider text-warm-brass font-medium">{m.date} '26</span>
                </div>
                <h4 className="font-serif text-base font-medium text-foreground mb-1">{m.title}</h4>
                <p className="text-xs text-muted-foreground">{m.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ========================================
          PERFORMANCE METRICS
          ======================================== */}
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

      {/* ========================================
          GEOGRAPHIC DISTRIBUTION
          ======================================== */}
      <section className="section-padding bg-background geo-section relative">
        <div className="container-wide relative z-10">
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6 mb-10">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-px bg-warm-brass" />
                <span className="text-xs uppercase tracking-[0.2em] text-warm-brass font-medium">Markets</span>
              </div>
              <h2 className="text-foreground mb-2">Geographic Distribution</h2>
              <p className="text-muted-foreground max-w-xl">
                Strategic presence across high-growth markets with strong rental demand.
              </p>
            </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            {/* Connecticut */}
            <div className="panel-summary p-6 md:p-8">
              <div className="flex items-center gap-4 mb-6">
                <div className="w-12 h-12 flex items-center justify-center bg-warm-brass/10 border border-warm-brass/20">
                  <MapPin className="w-5 h-5 text-warm-brass" />
                </div>
                <div>
                  <h3 className="text-xl font-serif font-medium text-foreground">Connecticut</h3>
                  <p className="text-sm text-warm-brass font-medium">Primary Market</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6 mb-6">
                <div>
                  <div className="text-2xl font-serif font-medium text-foreground mb-1" data-testid="ct-properties-count">
                    {ctProperties.length}
                  </div>
                  <div className="text-sm text-muted-foreground">Properties</div>
                </div>
                <div>
                  <div className="text-2xl font-serif font-medium text-foreground mb-1" data-testid="ct-units-count">
                    {ctUnits}
                  </div>
                  <div className="text-sm text-muted-foreground">Units</div>
                </div>
              </div>

              <div>
                <h4 className="text-xs uppercase tracking-[0.2em] text-muted-foreground mb-6">By City</h4>
                {Array.from(new Set(ctProperties.map(p => p.city))).map(city => {
                  const cityProperties = ctProperties.filter(p => p.city === city);
                  const cityUnits = cityProperties.reduce((sum, p) => sum + p.units, 0);
                  const percentage = (cityUnits / ctUnits) * 100;
                  return (
                    <div key={city} className="city-row">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-foreground font-medium">{city}</span>
                        <span className="text-muted-foreground text-sm" data-testid={`city-${city.replace(/\s+/g, '-').toLowerCase()}-stats`}>
                          {cityProperties.length} properties, {cityUnits} units
                        </span>
                      </div>
                      <div className="stat-bar">
                        <div className="stat-bar-fill" style={{ width: `${percentage}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Florida */}
            <div className="panel-summary p-6 md:p-8">
              <div className="flex items-center gap-4 mb-6">
                <div className="w-12 h-12 flex items-center justify-center bg-warm-brass/10 border border-warm-brass/20">
                  <Building2 className="w-5 h-5 text-warm-brass" />
                </div>
                <div>
                  <h3 className="text-xl font-serif font-medium text-foreground">Florida</h3>
                  <p className="text-sm text-warm-brass font-medium">Expansion Market</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6 mb-6">
                <div>
                  <div className="text-2xl font-serif font-medium text-foreground mb-1" data-testid="fl-properties-count">
                    {flProperties.length}
                  </div>
                  <div className="text-sm text-muted-foreground">Properties</div>
                </div>
                <div>
                  <div className="text-2xl font-serif font-medium text-foreground mb-1" data-testid="fl-units-count">
                    {flUnits}
                  </div>
                  <div className="text-sm text-muted-foreground">Units</div>
                </div>
              </div>

              {flProperties.length > 0 ? (
                <div>
                  <h4 className="text-xs uppercase tracking-[0.2em] text-muted-foreground mb-6">By City</h4>
                  {Array.from(new Set(flProperties.map(p => p.city))).map(city => {
                    const cityProperties = flProperties.filter(p => p.city === city);
                    const cityUnits = cityProperties.reduce((sum, p) => sum + p.units, 0);
                    const percentage = flUnits > 0 ? (cityUnits / flUnits) * 100 : 0;
                    return (
                      <div key={city} className="city-row">
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-foreground font-medium">{city}</span>
                          <span className="text-muted-foreground text-sm" data-testid={`city-${city.replace(/\s+/g, '-').toLowerCase()}-stats`}>
                            {cityProperties.length} properties, {cityUnits} units
                          </span>
                        </div>
                        <div className="stat-bar">
                          <div className="stat-bar-fill" style={{ width: `${percentage}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-12 border border-dashed border-border rounded-sm">
                  <Building2 className="w-10 h-10 text-muted-foreground/20 mx-auto mb-4" />
                  <p className="text-muted-foreground text-sm">Actively evaluating Florida markets</p>
                  <p className="text-muted-foreground/60 text-xs mt-1">Expansion opportunities in development</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ========================================
          CTA SECTION
          ======================================== */}
      <section className="section-padding bg-deep-charcoal text-white cta-split relative">
        <div className="max-w-5xl mx-auto px-6 lg:px-8 relative z-10">
          <div className="grid lg:grid-cols-2 gap-10 items-center">
            {/* Left content */}
            <div>
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-px bg-warm-brass" />
                <span className="text-xs uppercase tracking-[0.2em] text-warm-brass font-medium">Partner With Us</span>
              </div>

              <h2 className="text-white mb-4 leading-tight">
                Invest in Our
                <br />
                <span className="italic text-warm-brass">Next Property</span>
              </h2>

              <p className="text-lg text-white/50 mb-6 font-light leading-relaxed">
                Join our portfolio of successful investments. We're evaluating new opportunities in high-growth markets.
              </p>

              <div className="flex flex-col sm:flex-row gap-4">
                <Link href="/founder">
                  <Button className="btn-accent group w-full sm:w-auto" data-testid="button-schedule-consultation">
                    Schedule Consultation
                    <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
                  </Button>
                </Link>
                <Link href="/vision">
                  <Button
                    className="btn-outline border-white/20 text-white hover:bg-white hover:text-deep-charcoal w-full sm:w-auto"
                    data-testid="button-view-investment-vision"
                  >
                    View Our Vision
                  </Button>
                </Link>
              </div>
            </div>

            {/* Right - Contact card */}
            <div className="contact-card-float p-6 md:p-8 bg-card">
              <h3 className="text-lg font-serif font-medium text-foreground mb-5">Get in Touch</h3>

              <div className="space-y-4">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 flex items-center justify-center bg-warm-brass/10 border border-warm-brass/20 flex-shrink-0">
                    <Mail className="w-4 h-4 text-warm-brass" />
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Email</div>
                    <div className="text-foreground font-medium" data-testid="portfolio-contact-email">michael@5central.capital</div>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 flex items-center justify-center bg-warm-brass/10 border border-warm-brass/20 flex-shrink-0">
                    <Phone className="w-4 h-4 text-warm-brass" />
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Direct Line</div>
                    <div className="text-foreground font-medium" data-testid="portfolio-contact-phone">860-326-6094</div>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 flex items-center justify-center bg-warm-brass/10 border border-warm-brass/20 flex-shrink-0">
                    <Calendar className="w-4 h-4 text-warm-brass" />
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Schedule</div>
                    <div className="text-foreground font-medium" data-testid="portfolio-contact-schedule">Book a Meeting</div>
                  </div>
                </div>
              </div>

              <div className="mt-5 pt-5 border-t border-border">
                <p className="text-sm text-muted-foreground">
                  Minimum investments typically start at $50,000 for individual deals.
                  Accredited investors and institutional partners welcome.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Property Detail Modal */}
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
