import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type Property } from "@shared/schema";
import PropertyCard from "@/components/property-card";
import PropertyModal from "@/components/property-modal";
import PerformanceMetrics from "@/components/performance-metrics";
import { getPropertyImage } from "@/lib/property-data";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { useAnimatedCounter } from "@/hooks/use-animated-counter";
import {
  MapPin,
  Building2,
  Mail,
  Phone,
  Calendar,
  ArrowRight
} from "lucide-react";

function AnimatedStat({
  value,
  suffix = "",
  prefix = "",
  label,
  decimals = 0,
  delay = 0
}: {
  value: number;
  suffix?: string;
  prefix?: string;
  label: string;
  decimals?: number;
  delay?: number;
}) {
  const counter = useAnimatedCounter(value, { duration: 2000, delay, decimals });

  return (
    <div className="text-center">
      <div className="metric-value text-white mb-2">
        {prefix}
        {decimals > 0 ? counter.value.toFixed(decimals) : Math.round(counter.value).toLocaleString()}
        {suffix}
      </div>
      <div className="metric-label text-white/60">{label}</div>
    </div>
  );
}

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

  const openPropertyModal = (property: Property) => {
    setSelectedProperty(property);
    setIsModalOpen(true);
  };

  const closePropertyModal = () => {
    setIsModalOpen(false);
    setSelectedProperty(null);
  };

  const isLoading = currentLoading || soldLoading || allLoading;

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
    const acquisitionPrice = parseFloat(p.acquisitionPrice);
    const currentValue = parseFloat(p.currentValue || p.salePrice || "0");
    return sum + Math.max(0, currentValue - acquisitionPrice);
  }, 0);

  const avgReturn = allProperties.length > 0
    ? allProperties.reduce((sum, p) => sum + parseFloat(p.irr || "0"), 0) / allProperties.length
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

  const formatCurrency = (value: number) => {
    if (value >= 1000000) return value / 1000000;
    if (value >= 1000) return value / 1000;
    return value;
  };

  const getCurrencySuffix = (value: number) => {
    if (value >= 1000000) return "M";
    if (value >= 1000) return "K";
    return "";
  };

  return (
    <div className="min-h-screen pt-20 bg-background" data-testid="portfolio-page">
      {/* Hero Section */}
      <section className="py-24 bg-deep-charcoal text-white relative overflow-hidden">
        {/* Subtle texture */}
        <div
          className="absolute inset-0 opacity-[0.02]"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          }}
        />

        <div className="container-wide relative z-10">
          <div className="text-center mb-16">
            <div className="divider mx-auto mb-6 bg-warm-brass" />
            <h1 className="text-white mb-6" data-testid="portfolio-title">
              Investment <span className="italic text-warm-brass">Portfolio</span>
            </h1>
            <p className="text-xl text-white/60 max-w-2xl mx-auto font-light">
              Multifamily real estate investments across Connecticut and Florida markets
            </p>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-12" data-testid="portfolio-overview-stats">
            <AnimatedStat
              value={formatCurrency(currentPortfolioValue)}
              prefix="$"
              suffix={getCurrencySuffix(currentPortfolioValue)}
              label="Current Value"
              decimals={currentPortfolioValue >= 1000000 ? 2 : 0}
              delay={200}
            />
            <AnimatedStat
              value={currentProperties.length}
              label="Current Properties"
              delay={300}
            />
            <AnimatedStat
              value={currentUnits}
              label="Current Units"
              delay={400}
            />
            <AnimatedStat
              value={avgEquityMultiple}
              suffix="x"
              label="Avg Multiple"
              decimals={2}
              delay={500}
            />
          </div>
        </div>
      </section>

      {/* Portfolio Properties */}
      <section className="section-padding bg-background">
        <div className="container-wide">
          <div className="text-center mb-16">
            <div className="divider mx-auto mb-6" />
            <h2 className="text-foreground mb-4">Property Portfolio</h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Complete portfolio including current holdings and successful exits
            </p>
          </div>

          <Tabs defaultValue="all" className="w-full" data-testid="portfolio-tabs">
            <TabsList className="grid w-full grid-cols-3 mb-12 bg-transparent border border-border p-1">
              <TabsTrigger
                value="all"
                className="data-[state=active]:bg-warm-brass data-[state=active]:text-deep-charcoal text-sm uppercase tracking-wider font-medium"
                data-testid="tab-all-properties"
              >
                All ({allProperties.length})
              </TabsTrigger>
              <TabsTrigger
                value="current"
                className="data-[state=active]:bg-warm-brass data-[state=active]:text-deep-charcoal text-sm uppercase tracking-wider font-medium"
                data-testid="tab-current-properties"
              >
                Current ({currentProperties.length})
              </TabsTrigger>
              <TabsTrigger
                value="sold"
                className="data-[state=active]:bg-warm-brass data-[state=active]:text-deep-charcoal text-sm uppercase tracking-wider font-medium"
                data-testid="tab-sold-properties"
              >
                Exits ({soldProperties.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="all" data-testid="all-properties-content">
              {/* Current */}
              <div className="mb-20">
                <div className="mb-10">
                  <h3 className="text-2xl font-serif font-medium text-foreground mb-2">Current Holdings</h3>
                  <div className="divider mb-4" />
                  <p className="text-muted-foreground">
                    {currentProperties.length} active properties generating consistent returns
                  </p>
                </div>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                  {currentProperties.map((property) => (
                    <PropertyCard
                      key={property.id}
                      property={property}
                      imageUrl={getPropertyImage(property.name)}
                      onClick={() => openPropertyModal(property)}
                    />
                  ))}
                </div>
              </div>

              {/* Sold */}
              <div className="pt-12 border-t border-border">
                <div className="mb-10">
                  <h3 className="text-2xl font-serif font-medium text-foreground mb-2">Successful Exits</h3>
                  <div className="divider mb-4" />
                  <p className="text-muted-foreground">
                    {soldProperties.length} realized investments demonstrating proven value creation
                  </p>
                </div>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                  {soldProperties.map((property) => (
                    <div key={property.id} className="relative">
                      <PropertyCard
                        property={property}
                        imageUrl={getPropertyImage(property.name)}
                        onClick={() => openPropertyModal(property)}
                      />
                      <Badge
                        className="absolute top-4 right-4 bg-muted text-muted-foreground border-0 text-xs uppercase tracking-wider"
                        data-testid={`property-status-${property.id}`}
                      >
                        Sold
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="current" data-testid="current-properties-content">
              {/* Summary Card */}
              <div className="card-refined p-8 mb-12">
                <h3 className="text-xl font-serif font-medium text-foreground mb-8">Current Holdings Overview</h3>
                <div className="grid md:grid-cols-3 gap-8">
                  <div className="text-center">
                    <div className="text-3xl font-serif font-medium text-warm-brass" data-testid="current-total-value">
                      ${(currentProperties.reduce((sum, p) => sum + parseFloat(p.currentValue || "0"), 0) / 1000000).toFixed(2)}M
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">Current Value</div>
                  </div>
                  <div className="text-center border-x border-border">
                    <div className="text-3xl font-serif font-medium text-warm-brass" data-testid="current-total-units">
                      {currentProperties.reduce((sum, p) => sum + p.units, 0)}
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">Active Units</div>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-serif font-medium text-warm-brass" data-testid="current-avg-irr">
                      {(currentProperties.reduce((sum, p) => sum + parseFloat(p.irr || "0"), 0) / currentProperties.length).toFixed(1)}%
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">Avg Current IRR</div>
                  </div>
                </div>
              </div>

              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                {currentProperties.map((property) => (
                  <PropertyCard
                    key={property.id}
                    property={property}
                    imageUrl={getPropertyImage(property.name)}
                    onClick={() => openPropertyModal(property)}
                  />
                ))}
              </div>
            </TabsContent>

            <TabsContent value="sold" data-testid="sold-properties-content">
              {/* Summary Card */}
              <div className="card-refined p-8 mb-12">
                <h3 className="text-xl font-serif font-medium text-foreground mb-8">Exits Overview</h3>
                <div className="grid md:grid-cols-3 gap-8">
                  <div className="text-center">
                    <div className="text-3xl font-serif font-medium text-warm-brass" data-testid="sold-total-profits">
                      ${(totalRealizedProfits / 1000).toFixed(0)}K
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">Total Realized Profits</div>
                  </div>
                  <div className="text-center border-x border-border">
                    <div className="text-3xl font-serif font-medium text-warm-brass" data-testid="sold-avg-multiple">
                      {(soldProperties.reduce((sum, p) => sum + parseFloat(p.equityMultiple || "0"), 0) / soldProperties.length).toFixed(2)}x
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">Avg Equity Multiple</div>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-serif font-medium text-warm-brass" data-testid="sold-avg-hold-period">
                      {(soldProperties.reduce((sum, p) => sum + parseFloat(p.yearsHeld || "0"), 0) / soldProperties.length).toFixed(1)}
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">Avg Hold Period (Years)</div>
                  </div>
                </div>
              </div>

              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                {soldProperties.map((property) => (
                  <PropertyCard
                    key={property.id}
                    property={property}
                    imageUrl={getPropertyImage(property.name)}
                    onClick={() => openPropertyModal(property)}
                  />
                ))}
              </div>
            </TabsContent>
          </Tabs>
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

      {/* Geographic Distribution */}
      <section className="section-padding bg-background">
        <div className="container-wide">
          <div className="text-center mb-16">
            <div className="divider mx-auto mb-6" />
            <h2 className="text-foreground mb-4">Geographic Distribution</h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Strategic presence across high-growth markets
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-8">
            {/* Connecticut */}
            <div className="card-refined p-8">
              <div className="flex items-center gap-4 mb-8">
                <div className="w-12 h-12 flex items-center justify-center border border-border">
                  <MapPin className="w-5 h-5 text-warm-brass" />
                </div>
                <div>
                  <h3 className="text-2xl font-serif font-medium text-foreground">Connecticut</h3>
                  <p className="text-sm text-muted-foreground">Primary Market</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6 mb-8">
                <div>
                  <div className="text-2xl font-serif font-medium text-foreground" data-testid="ct-properties-count">
                    {ctProperties.length}
                  </div>
                  <div className="text-sm text-muted-foreground">Properties</div>
                </div>
                <div>
                  <div className="text-2xl font-serif font-medium text-foreground" data-testid="ct-units-count">
                    {ctUnits}
                  </div>
                  <div className="text-sm text-muted-foreground">Units</div>
                </div>
              </div>

              <div className="space-y-3">
                <h4 className="text-sm uppercase tracking-wider text-muted-foreground mb-4">By City</h4>
                {Array.from(new Set(ctProperties.map(p => p.city))).map(city => {
                  const cityProperties = ctProperties.filter(p => p.city === city);
                  const cityUnits = cityProperties.reduce((sum, p) => sum + p.units, 0);
                  return (
                    <div key={city} className="flex justify-between items-center py-2 border-b border-border last:border-0">
                      <span className="text-muted-foreground">{city}</span>
                      <span className="text-foreground font-medium" data-testid={`city-${city.replace(/\s+/g, '-').toLowerCase()}-stats`}>
                        {cityProperties.length} prop, {cityUnits} units
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Florida */}
            <div className="card-refined p-8">
              <div className="flex items-center gap-4 mb-8">
                <div className="w-12 h-12 flex items-center justify-center border border-border">
                  <Building2 className="w-5 h-5 text-warm-brass" />
                </div>
                <div>
                  <h3 className="text-2xl font-serif font-medium text-foreground">Florida</h3>
                  <p className="text-sm text-muted-foreground">Expansion Market</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6 mb-8">
                <div>
                  <div className="text-2xl font-serif font-medium text-foreground" data-testid="fl-properties-count">
                    {flProperties.length}
                  </div>
                  <div className="text-sm text-muted-foreground">Properties</div>
                </div>
                <div>
                  <div className="text-2xl font-serif font-medium text-foreground" data-testid="fl-units-count">
                    {flUnits}
                  </div>
                  <div className="text-sm text-muted-foreground">Units</div>
                </div>
              </div>

              {flProperties.length > 0 ? (
                <div className="space-y-3">
                  <h4 className="text-sm uppercase tracking-wider text-muted-foreground mb-4">By City</h4>
                  {Array.from(new Set(flProperties.map(p => p.city))).map(city => {
                    const cityProperties = flProperties.filter(p => p.city === city);
                    const cityUnits = cityProperties.reduce((sum, p) => sum + p.units, 0);
                    return (
                      <div key={city} className="flex justify-between items-center py-2 border-b border-border last:border-0">
                        <span className="text-muted-foreground">{city}</span>
                        <span className="text-foreground font-medium" data-testid={`city-${city.replace(/\s+/g, '-').toLowerCase()}-stats`}>
                          {cityProperties.length} prop, {cityUnits} units
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-8">
                  <Building2 className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
                  <p className="text-muted-foreground text-sm">Expanding into Florida markets</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="section-padding bg-deep-charcoal text-white">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <div className="divider mx-auto mb-6 bg-warm-brass" />
          <h2 className="text-white mb-6">Invest in Our Next Property</h2>
          <p className="text-xl text-white/60 mb-12 max-w-2xl mx-auto font-light">
            Join our portfolio of successful investments. We're evaluating new opportunities in high-growth markets.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-16">
            <Link href="/founder">
              <Button className="btn-accent group" data-testid="button-schedule-consultation">
                Schedule Consultation
                <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
              </Button>
            </Link>
            <Link href="/vision">
              <Button
                className="btn-outline border-white/30 text-white hover:bg-white hover:text-deep-charcoal"
                data-testid="button-view-investment-vision"
              >
                View Our Vision
              </Button>
            </Link>
          </div>

          <div className="grid md:grid-cols-3 gap-12 pt-12 border-t border-white/10">
            <div className="text-center">
              <Mail className="w-5 h-5 text-warm-brass mx-auto mb-3" />
              <div className="text-lg font-medium text-white mb-1" data-testid="portfolio-contact-email">michael@5central.capital</div>
              <div className="text-sm text-white/50 uppercase tracking-wider">Investment Inquiries</div>
            </div>
            <div className="text-center">
              <Phone className="w-5 h-5 text-warm-brass mx-auto mb-3" />
              <div className="text-lg font-medium text-white mb-1" data-testid="portfolio-contact-phone">860-326-6094</div>
              <div className="text-sm text-white/50 uppercase tracking-wider">Direct Line</div>
            </div>
            <div className="text-center">
              <Calendar className="w-5 h-5 text-warm-brass mx-auto mb-3" />
              <div className="text-lg font-medium text-white mb-1" data-testid="portfolio-contact-schedule">Book Meeting</div>
              <div className="text-sm text-white/50 uppercase tracking-wider">Schedule Call</div>
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
    </div>
  );
}
