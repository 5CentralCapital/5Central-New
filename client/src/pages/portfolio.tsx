import { useQuery } from "@tanstack/react-query";
import { type Property } from "@shared/schema";
import PropertyCard from "@/components/property-card";
import PerformanceMetrics from "@/components/performance-metrics";
import { getPropertyImage } from "@/lib/property-data";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { 
  TrendingUp, 
  Building2, 
  MapPin, 
  Calendar,
  Mail,
  Phone,
  ArrowRight
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

  const isLoading = currentLoading || soldLoading || allLoading;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center pt-16" data-testid="portfolio-loading">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-accent-gold mx-auto mb-4"></div>
          <div className="text-xl font-serif text-primary">Loading Portfolio...</div>
        </div>
      </div>
    );
  }

  // Calculate metrics for CURRENT properties only (for header)
  const currentPortfolioValue = currentProperties.reduce((sum, p) => {
    const value = parseFloat(p.currentValue || "0");
    return sum + value;
  }, 0);

  const currentUnits = currentProperties.reduce((sum, p) => sum + p.units, 0);

  // Calculate metrics for ALL properties (current + sold) for performance metrics section
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

  const avgReturn = allProperties.length > 0 ? allProperties.reduce((sum, p) => {
    const irr = parseFloat(p.irr || "0");
    return sum + irr;
  }, 0) / allProperties.length : 0;

  const avgEquityMultiple = allProperties.length > 0 ? allProperties.reduce((sum, p) => {
    const multiple = parseFloat(p.equityMultiple || "0");
    return sum + multiple;
  }, 0) / allProperties.length : 0;

  const totalRealizedProfits = soldProperties.reduce((sum, p) => {
    const acquisitionPrice = parseFloat(p.acquisitionPrice);
    const salePrice = parseFloat(p.salePrice || "0");
    return sum + Math.max(0, salePrice - acquisitionPrice);
  }, 0);

  // Calculate state breakdown
  const ctProperties = allProperties.filter(p => p.state === 'CT');
  const flProperties = allProperties.filter(p => p.state === 'FL');
  const ctUnits = ctProperties.reduce((sum, p) => sum + p.units, 0);
  const flUnits = flProperties.reduce((sum, p) => sum + p.units, 0);

  const formatCurrency = (value: number) => {
    if (value >= 1000000) {
      return `$${(value / 1000000).toFixed(2)}M`;
    } else if (value >= 1000) {
      return `$${(value / 1000).toFixed(0)}K`;
    }
    return `$${value.toLocaleString()}`;
  };

  return (
    <div className="min-h-screen pt-16" data-testid="portfolio-page">
      {/* Hero Section */}
      <section className="py-20 bg-gradient-to-br from-primary to-gray-800 text-white relative overflow-hidden">
        <div className="geometric-pattern absolute inset-0 opacity-10"></div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center mb-16">
            <h1 className="text-5xl md:text-6xl font-serif font-bold mb-6" data-testid="portfolio-title">
              Investment <span className="text-accent-gold">Portfolio</span>
            </h1>
            <p className="text-xl text-gray-300 max-w-3xl mx-auto">
              A comprehensive view of our multifamily real estate investments across Connecticut and Florida markets
            </p>
          </div>

          {/* Portfolio Overview Stats - Current Properties Only */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8" data-testid="portfolio-overview-stats">
            <div className="text-center">
              <div className="text-3xl md:text-4xl font-bold text-accent-gold mb-2" data-testid="current-portfolio-value">
                {formatCurrency(currentPortfolioValue)}
              </div>
              <div className="text-gray-300 text-sm uppercase tracking-wide">Current Portfolio Value</div>
            </div>
            <div className="text-center">
              <div className="text-3xl md:text-4xl font-bold text-accent-gold mb-2" data-testid="current-properties">
                {currentProperties.length}
              </div>
              <div className="text-gray-300 text-sm uppercase tracking-wide">Current Properties</div>
            </div>
            <div className="text-center">
              <div className="text-3xl md:text-4xl font-bold text-accent-gold mb-2" data-testid="current-units">
                {currentUnits}
              </div>
              <div className="text-gray-300 text-sm uppercase tracking-wide">Current Units</div>
            </div>
            <div className="text-center">
              <div className="text-3xl md:text-4xl font-bold text-accent-gold mb-2" data-testid="avg-equity-multiple">
                {avgEquityMultiple.toFixed(2)}x
              </div>
              <div className="text-gray-300 text-sm uppercase tracking-wide">Avg Equity Multiple</div>
            </div>
          </div>
        </div>
      </section>

      {/* Portfolio Properties */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-4">Property Portfolio</h2>
            <p className="text-xl text-gray-600 max-w-3xl mx-auto">
              Explore our complete portfolio of multifamily properties, including current holdings and successful exits
            </p>
          </div>

          <Tabs defaultValue="all" className="w-full" data-testid="portfolio-tabs">
            <TabsList className="grid w-full grid-cols-3 mb-8 bg-secondary rounded-xl p-2">
              <TabsTrigger 
                value="all" 
                className="rounded-lg data-[state=active]:bg-accent-gold data-[state=active]:text-white font-semibold"
                data-testid="tab-all-properties"
              >
                All Properties ({allProperties.length})
              </TabsTrigger>
              <TabsTrigger 
                value="current" 
                className="rounded-lg data-[state=active]:bg-accent-gold data-[state=active]:text-white font-semibold"
                data-testid="tab-current-properties"
              >
                Current Holdings ({currentProperties.length})
              </TabsTrigger>
              <TabsTrigger 
                value="sold" 
                className="rounded-lg data-[state=active]:bg-accent-gold data-[state=active]:text-white font-semibold"
                data-testid="tab-sold-properties"
              >
                Successful Exits ({soldProperties.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="all" data-testid="all-properties-content">
              {/* Currently Owned Properties Section */}
              <div className="mb-16">
                <div className="mb-8">
                  <h3 className="text-3xl font-serif font-bold text-primary mb-2">Currently Owned Properties</h3>
                  <div className="w-24 h-1 bg-accent-gold mb-6"></div>
                  <p className="text-gray-600 text-lg">
                    Our active portfolio of {currentProperties.length} multifamily properties generating consistent returns
                  </p>
                </div>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                  {currentProperties.map((property) => (
                    <div key={property.id} className="relative">
                      <PropertyCard
                        property={property}
                        imageUrl={getPropertyImage(property.name)}
                      />
                      <Badge 
                        className="absolute top-4 right-4 bg-green-100 text-green-800"
                        data-testid={`property-status-${property.id}`}
                      >
                        Current
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>

              {/* Sold Properties Section */}
              <div className="pt-8 border-t border-gray-200">
                <div className="mb-8">
                  <h3 className="text-3xl font-serif font-bold text-primary mb-2">Successful Exits</h3>
                  <div className="w-24 h-1 bg-accent-gold mb-6"></div>
                  <p className="text-gray-600 text-lg">
                    Our track record of {soldProperties.length} successful property sales demonstrating proven value creation
                  </p>
                </div>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                  {soldProperties.map((property) => (
                    <div key={property.id} className="relative">
                      <PropertyCard
                        property={property}
                        imageUrl={getPropertyImage(property.name)}
                      />
                      <Badge 
                        className="absolute top-4 right-4 bg-blue-100 text-blue-800"
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
              <div className="mb-8">
                <Card className="bg-gradient-to-r from-secondary to-gray-100 rounded-2xl p-6">
                  <CardContent className="p-0">
                    <h3 className="text-2xl font-serif font-bold text-primary mb-4">Current Holdings Overview</h3>
                    <div className="grid md:grid-cols-3 gap-6">
                      <div className="text-center">
                        <div className="text-2xl font-bold text-accent-gold" data-testid="current-total-value">
                          {formatCurrency(currentProperties.reduce((sum, p) => sum + parseFloat(p.currentValue || "0"), 0))}
                        </div>
                        <div className="text-gray-600">Current Value</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-accent-gold" data-testid="current-total-units">
                          {currentProperties.reduce((sum, p) => sum + p.units, 0)}
                        </div>
                        <div className="text-gray-600">Active Units</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-accent-gold" data-testid="current-avg-irr">
                          {(currentProperties.reduce((sum, p) => sum + parseFloat(p.irr || "0"), 0) / currentProperties.length).toFixed(1)}%
                        </div>
                        <div className="text-gray-600">Avg Current IRR</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                {currentProperties.map((property) => (
                  <PropertyCard
                    key={property.id}
                    property={property}
                    imageUrl={getPropertyImage(property.name)}
                  />
                ))}
              </div>
            </TabsContent>

            <TabsContent value="sold" data-testid="sold-properties-content">
              <div className="mb-8">
                <Card className="bg-gradient-to-r from-secondary to-gray-100 rounded-2xl p-6">
                  <CardContent className="p-0">
                    <h3 className="text-2xl font-serif font-bold text-primary mb-4">Successful Exits Overview</h3>
                    <div className="grid md:grid-cols-3 gap-6">
                      <div className="text-center">
                        <div className="text-2xl font-bold text-accent-gold" data-testid="sold-total-profits">
                          {formatCurrency(totalRealizedProfits)}
                        </div>
                        <div className="text-gray-600">Total Realized Profits</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-accent-gold" data-testid="sold-avg-multiple">
                          {(soldProperties.reduce((sum, p) => sum + parseFloat(p.equityMultiple || "0"), 0) / soldProperties.length).toFixed(2)}x
                        </div>
                        <div className="text-gray-600">Avg Equity Multiple</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-accent-gold" data-testid="sold-avg-hold-period">
                          {(soldProperties.reduce((sum, p) => sum + parseFloat(p.yearsHeld || "0"), 0) / soldProperties.length).toFixed(1)}
                        </div>
                        <div className="text-gray-600">Avg Hold Period (Years)</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                {soldProperties.map((property) => (
                  <PropertyCard
                    key={property.id}
                    property={property}
                    imageUrl={getPropertyImage(property.name)}
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
      />

      {/* Geographic Breakdown */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-serif font-bold text-primary mb-4">Geographic Distribution</h2>
            <p className="text-xl text-gray-600 max-w-3xl mx-auto">
              Our strategic presence across high-growth markets in Connecticut and Florida
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-12">
            {/* Connecticut Portfolio */}
            <Card className="bg-gradient-to-br from-secondary to-gray-100 rounded-2xl p-8 card-shadow premium-border">
              <CardContent className="p-0">
                <div className="flex items-center gap-4 mb-6">
                  <div className="w-16 h-16 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center">
                    <MapPin className="w-8 h-8 text-white" />
                  </div>
                  <div>
                    <h3 className="text-3xl font-serif font-bold text-primary">Connecticut</h3>
                    <p className="text-gray-600">Primary Market Focus</p>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-6 mb-6">
                  <div>
                    <div className="text-2xl font-bold text-primary" data-testid="ct-properties-count">
                      {ctProperties.length}
                    </div>
                    <div className="text-gray-600">Properties</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-primary" data-testid="ct-units-count">
                      {ctUnits}
                    </div>
                    <div className="text-gray-600">Units</div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h4 className="text-lg font-semibold text-primary mb-3">Properties by City:</h4>
                  {Array.from(new Set(ctProperties.map(p => p.city))).map(city => {
                    const cityProperties = ctProperties.filter(p => p.city === city);
                    const cityUnits = cityProperties.reduce((sum, p) => sum + p.units, 0);
                    return (
                      <div key={city} className="flex justify-between items-center">
                        <span className="text-gray-600">{city}</span>
                        <span className="font-medium text-primary" data-testid={`city-${city.replace(/\s+/g, '-').toLowerCase()}-stats`}>
                          {cityProperties.length} properties, {cityUnits} units
                        </span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Florida Portfolio */}
            <Card className="bg-gradient-to-br from-secondary to-gray-100 rounded-2xl p-8 card-shadow premium-border">
              <CardContent className="p-0">
                <div className="flex items-center gap-4 mb-6">
                  <div className="w-16 h-16 bg-gradient-to-br from-accent-gold to-bronze rounded-full flex items-center justify-center">
                    <Building2 className="w-8 h-8 text-white" />
                  </div>
                  <div>
                    <h3 className="text-3xl font-serif font-bold text-primary">Florida</h3>
                    <p className="text-gray-600">Expansion Market</p>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-6 mb-6">
                  <div>
                    <div className="text-2xl font-bold text-primary" data-testid="fl-properties-count">
                      {flProperties.length}
                    </div>
                    <div className="text-gray-600">Properties</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-primary" data-testid="fl-units-count">
                      {flUnits}
                    </div>
                    <div className="text-gray-600">Units</div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h4 className="text-lg font-semibold text-primary mb-3">Properties by City:</h4>
                  {Array.from(new Set(flProperties.map(p => p.city))).map(city => {
                    const cityProperties = flProperties.filter(p => p.city === city);
                    const cityUnits = cityProperties.reduce((sum, p) => sum + p.units, 0);
                    return (
                      <div key={city} className="flex justify-between items-center">
                        <span className="text-gray-600">{city}</span>
                        <span className="font-medium text-primary" data-testid={`city-${city.replace(/\s+/g, '-').toLowerCase()}-stats`}>
                          {cityProperties.length} properties, {cityUnits} units
                        </span>
                      </div>
                    );
                  })}
                </div>

                {flProperties.length === 0 && (
                  <div className="text-center text-gray-500 py-8">
                    <Building2 className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p>Expanding into Florida markets</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Investment Opportunity CTA */}
      <section className="py-20 bg-gradient-to-br from-primary to-gray-800 text-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-4xl md:text-5xl font-serif font-bold mb-6">Invest in Our Next Property</h2>
          <p className="text-xl text-gray-300 mb-12 max-w-2xl mx-auto">
            Join our portfolio of successful investments. We're always evaluating new opportunities in high-growth markets with exceptional return potential.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-6 justify-center mb-16">
            <Link href="/founder">
              <Button 
                className="bg-gradient-to-r from-accent-gold to-bronze text-white px-10 py-4 rounded-lg font-semibold text-lg hover:shadow-lg transition-all duration-300 transform hover:-translate-y-1"
                data-testid="button-schedule-consultation"
              >
                Schedule Consultation
                <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
            </Link>
            <Link href="/vision">
              <Button 
                variant="outline"
                className="border-2 border-accent-gold text-accent-gold px-10 py-4 rounded-lg font-semibold text-lg hover:bg-accent-gold hover:text-primary transition-all duration-300"
                data-testid="button-view-investment-vision"
              >
                View Our Vision
              </Button>
            </Link>
          </div>

          <div className="grid md:grid-cols-3 gap-8 text-center">
            <div className="flex flex-col items-center">
              <Mail className="w-8 h-8 text-accent-gold mb-2" />
              <div className="text-2xl font-bold text-white mb-2" data-testid="portfolio-contact-email">
                info@5central.capital
              </div>
              <div className="text-gray-300">Investment Inquiries</div>
            </div>
            <div className="flex flex-col items-center">
              <Phone className="w-8 h-8 text-accent-gold mb-2" />
              <div className="text-2xl font-bold text-white mb-2" data-testid="portfolio-contact-phone">
                (813) 555-0100
              </div>
              <div className="text-gray-300">Direct Line</div>
            </div>
            <div className="flex flex-col items-center">
              <Calendar className="w-8 h-8 text-accent-gold mb-2" />
              <div className="text-2xl font-bold text-white mb-2" data-testid="portfolio-contact-schedule">
                Book Meeting
              </div>
              <div className="text-gray-300">Schedule Call</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
