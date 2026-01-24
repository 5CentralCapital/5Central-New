import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getQueryFn } from "@/lib/queryClient";
import { getPropertyImage } from "@/lib/property-data";
import PropertyModal from "@/components/property-modal";
import { type Property } from "@shared/schema";
import {
  DollarSign,
  TrendingUp,
  FileText,
  Mail,
  Phone,
  Building2,
  Calendar,
  Download,
  Percent,
  Briefcase,
  PieChart,
  ArrowUpRight,
  MapPin,
} from "lucide-react";

interface Investment {
  id: string;
  investorId: string;
  propertyName: string;
  propertyAddress: string | null;
  principal: string;
  balloonAmount: string | null;
  monthlyPayment: string | null;
  returnMultiple: string | null;
  interestRate: string | null;
  effectiveDate: string | null;
  maturityDate: string | null;
  term: string | null;
  status: string;
  investmentType: string;
  notes: string | null;
  createdAt: string;
  // Equity investment fields
  equityPercentage: string | null;
  propertyId: string | null;
  initialInvestment: string | null;
  currentEquityValue: string | null;
  cashOutAtRefi: string | null;
  projectedExitValue: string | null;
  equityMultiple: string | null;
  // Enriched property data
  property?: Property | null;
}

interface InvestorProfile {
  id: string;
  userId: string;
  accreditedStatus: string;
  investedAmount: string;
  phone: string | null;
  investorType: string;
  companyEquityPercentage: string | null;
}

interface PortfolioMetrics {
  totalValue: number;
  totalEquity: number;
  propertyCount: number;
  partnerEquityPercentage: number;
  partnerEquityValue: number;
}

export default function InvestorDashboard() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState("overview");
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

  const { data: profile } = useQuery<InvestorProfile | null>({
    queryKey: ["/api/investor/profile"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    enabled: !!user,
    staleTime: 0,
  });

  const { data: investmentsData, isLoading } = useQuery<Investment[] | null>({
    queryKey: ["/api/investor/investments/enriched"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    enabled: !!user,
    staleTime: 0,
  });

  const { data: investorProperties } = useQuery<Property[] | null>({
    queryKey: ["/api/investor/properties"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    enabled: !!user,
    staleTime: 0,
  });

  const { data: portfolioMetrics } = useQuery<PortfolioMetrics | null>({
    queryKey: ["/api/investor/portfolio-metrics"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    enabled: !!user && profile?.investorType === "company-partner",
    staleTime: 0,
  });

  const investments = investmentsData || [];
  const properties = investorProperties || [];
  const isCompanyPartner = profile?.investorType === "company-partner";

  const formatCurrency = (value: string | number | null | undefined) => {
    if (!value) return "$0";
    const num = typeof value === "string" ? parseFloat(value) : value;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(num);
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "N/A";
    return new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const formatPercent = (value: string | number | null | undefined) => {
    if (!value) return "0%";
    const num = typeof value === "string" ? parseFloat(value) : value;
    return `${(num * 100).toFixed(0)}%`;
  };

  // Calculate totals from real data with proper equity handling
  const totalInvested = investments.reduce((sum, inv) => {
    // For equity investments, use initialInvestment
    if (inv.investmentType === "equity" && inv.initialInvestment) {
      return sum + parseFloat(inv.initialInvestment);
    }
    return sum + parseFloat(inv.principal || "0");
  }, 0);

  const totalBalloon = investments.reduce(
    (sum, inv) => sum + parseFloat(inv.balloonAmount || "0"),
    0
  );

  const totalMonthlyPayments = investments.reduce(
    (sum, inv) => sum + parseFloat(inv.monthlyPayment || "0"),
    0
  );

  // Fixed projected value calculation
  const projectedValue = investments.reduce((sum, inv) => {
    // For equity investments, use currentEquityValue (accounts for debt)
    if (inv.investmentType === "equity" && inv.currentEquityValue) {
      return sum + parseFloat(inv.currentEquityValue);
    }
    // For debt investments with balloon payments
    if (inv.balloonAmount) {
      return sum + parseFloat(inv.balloonAmount);
    }
    // For amortizing loans, estimate total payments
    if (inv.monthlyPayment && inv.term) {
      const months = inv.term.includes("24") ? 24 : 12;
      return sum + parseFloat(inv.monthlyPayment) * months;
    }
    return sum + parseFloat(inv.principal || "0");
  }, 0);

  const avgMultiple =
    investments.filter((inv) => inv.returnMultiple || inv.equityMultiple).length > 0
      ? investments.reduce(
          (sum, inv) => sum + parseFloat(inv.equityMultiple || inv.returnMultiple || "0"),
          0
        ) / investments.filter((inv) => inv.returnMultiple || inv.equityMultiple).length
      : 0;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center pt-20 bg-background">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-warm-brass border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground text-sm uppercase tracking-wider">
            Loading Portfolio
          </p>
        </div>
      </div>
    );
  }

  // Company Partner Dashboard
  if (isCompanyPartner && portfolioMetrics) {
    return (
      <>
        <CompanyPartnerDashboard
          user={user}
          profile={profile}
          metrics={portfolioMetrics}
          properties={properties}
          onPropertyClick={openPropertyModal}
        />
        <PropertyModal
          property={selectedProperty}
          isOpen={isModalOpen}
          onClose={closePropertyModal}
        />
      </>
    );
  }

  return (
    <div className="min-h-screen pt-20 bg-background">
      {/* Welcome Header */}
      <section className="py-16 bg-deep-charcoal text-white relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.02]"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          }}
        />

        <div className="container-wide relative z-10">
          <div className="divider mx-auto mb-6 bg-warm-brass" />
          <h1 className="text-white text-center mb-4">
            Welcome,{" "}
            <span className="italic text-warm-brass">{user?.firstName}</span>
          </h1>
          <p className="text-xl text-white/60 text-center max-w-2xl mx-auto font-light">
            Your investment portfolio at a glance
          </p>
        </div>
      </section>

      {/* Tabbed Dashboard */}
      <section className="section-padding bg-background">
        <div className="container-wide">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-4 mb-12 bg-transparent border border-border p-1">
              <TabsTrigger
                value="overview"
                className="data-[state=active]:bg-warm-brass data-[state=active]:text-deep-charcoal text-sm uppercase tracking-wider font-medium"
              >
                Overview
              </TabsTrigger>
              <TabsTrigger
                value="investments"
                className="data-[state=active]:bg-warm-brass data-[state=active]:text-deep-charcoal text-sm uppercase tracking-wider font-medium"
              >
                My Investments
              </TabsTrigger>
              <TabsTrigger
                value="properties"
                className="data-[state=active]:bg-warm-brass data-[state=active]:text-deep-charcoal text-sm uppercase tracking-wider font-medium"
              >
                Properties
              </TabsTrigger>
              <TabsTrigger
                value="documents"
                className="data-[state=active]:bg-warm-brass data-[state=active]:text-deep-charcoal text-sm uppercase tracking-wider font-medium"
              >
                Documents
              </TabsTrigger>
            </TabsList>

            {/* Overview Tab */}
            <TabsContent value="overview" className="animate-in fade-in-50 duration-500">
              <OverviewTab
                investments={investments}
                totalInvested={totalInvested}
                projectedValue={projectedValue}
                totalMonthlyPayments={totalMonthlyPayments}
                avgMultiple={avgMultiple}
                formatCurrency={formatCurrency}
              />
            </TabsContent>

            {/* My Investments Tab */}
            <TabsContent value="investments" className="animate-in fade-in-50 duration-500">
              <InvestmentsTab
                investments={investments}
                formatCurrency={formatCurrency}
                formatDate={formatDate}
                formatPercent={formatPercent}
              />
            </TabsContent>

            {/* Properties Tab */}
            <TabsContent value="properties" className="animate-in fade-in-50 duration-500">
              <PropertiesTab
                properties={properties}
                investments={investments}
                formatCurrency={formatCurrency}
                formatPercent={formatPercent}
                onPropertyClick={openPropertyModal}
              />
            </TabsContent>

            {/* Documents Tab */}
            <TabsContent value="documents" className="animate-in fade-in-50 duration-500">
              <DocumentsTab />
            </TabsContent>
          </Tabs>
        </div>
      </section>

      {/* Contact Section */}
      <section className="section-padding bg-deep-charcoal text-white">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <div className="divider mx-auto mb-6 bg-warm-brass" />
          <h2 className="text-white mb-6">Questions About Your Investment?</h2>
          <p className="text-xl text-white/60 mb-12 max-w-2xl mx-auto font-light">
            We're here to help. Reach out to discuss your portfolio or explore
            new opportunities.
          </p>

          <div className="grid md:grid-cols-2 gap-12 pt-12 border-t border-white/10">
            <div className="text-center">
              <Mail className="w-6 h-6 text-warm-brass mx-auto mb-3" />
              <div className="text-lg font-medium text-white mb-1">
                michael@5central.capital
              </div>
              <div className="text-sm text-white/50 uppercase tracking-wider">
                Email
              </div>
            </div>
            <div className="text-center">
              <Phone className="w-6 h-6 text-warm-brass mx-auto mb-3" />
              <div className="text-lg font-medium text-white mb-1">
                860-326-6094
              </div>
              <div className="text-sm text-white/50 uppercase tracking-wider">
                Direct Line
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Property Modal */}
      <PropertyModal
        property={selectedProperty}
        isOpen={isModalOpen}
        onClose={closePropertyModal}
      />
    </div>
  );
}

// Overview Tab Component
function OverviewTab({
  investments,
  totalInvested,
  projectedValue,
  totalMonthlyPayments,
  avgMultiple,
  formatCurrency,
}: {
  investments: Investment[];
  totalInvested: number;
  projectedValue: number;
  totalMonthlyPayments: number;
  avgMultiple: number;
  formatCurrency: (value: string | number | null | undefined) => string;
}) {
  return (
    <div className="space-y-12">
      {/* Summary Cards */}
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="card-refined">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Total Invested
            </CardTitle>
            <DollarSign className="h-5 w-5 text-warm-brass" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-serif font-medium text-foreground">
              {formatCurrency(totalInvested)}
            </div>
          </CardContent>
        </Card>

        <Card className="card-refined">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Current Value
            </CardTitle>
            <TrendingUp className="h-5 w-5 text-warm-brass" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-serif font-medium text-foreground">
              {formatCurrency(projectedValue)}
            </div>
            {projectedValue > totalInvested && (
              <p className="text-sm text-green-600 mt-1 flex items-center gap-1">
                <ArrowUpRight className="h-4 w-4" />
                +{formatCurrency(projectedValue - totalInvested)}
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="card-refined">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              {totalMonthlyPayments > 0 ? "Monthly Income" : "Avg Multiple"}
            </CardTitle>
            {totalMonthlyPayments > 0 ? (
              <DollarSign className="h-5 w-5 text-warm-brass" />
            ) : (
              <Percent className="h-5 w-5 text-warm-brass" />
            )}
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-serif font-medium text-foreground">
              {totalMonthlyPayments > 0
                ? formatCurrency(totalMonthlyPayments)
                : `${avgMultiple.toFixed(2)}x`}
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {totalMonthlyPayments > 0 ? "Per month" : "Return multiple"}
            </p>
          </CardContent>
        </Card>

        <Card className="card-refined">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Investments
            </CardTitle>
            <Building2 className="h-5 w-5 text-warm-brass" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-serif font-medium text-foreground">
              {investments.length}
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Active positions
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Investments Summary */}
      <div>
        <div className="text-center mb-10">
          <div className="divider mx-auto mb-6" />
          <h2 className="text-foreground mb-4">Investment Summary</h2>
          <p className="text-lg text-muted-foreground">
            Quick overview of your active investments
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {investments.slice(0, 3).map((inv) => (
            <Card key={inv.id} className="card-refined">
              <CardContent className="p-6">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 flex items-center justify-center border border-border rounded">
                    <Building2 className="w-4 h-4 text-warm-brass" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-serif font-medium text-foreground mb-1">
                      {inv.propertyName}
                    </h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      {inv.investmentType === "equity" ? "Equity Investment" : "Debt Investment"}
                    </p>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">
                        {inv.investmentType === "equity" ? "Equity Value" : "Principal"}
                      </span>
                      <span className="font-medium text-foreground">
                        {formatCurrency(
                          inv.investmentType === "equity" && inv.currentEquityValue
                            ? inv.currentEquityValue
                            : inv.balloonAmount || inv.principal
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

// Investments Tab Component
function InvestmentsTab({
  investments,
  formatCurrency,
  formatDate,
  formatPercent,
}: {
  investments: Investment[];
  formatCurrency: (value: string | number | null | undefined) => string;
  formatDate: (dateString: string | null) => string;
  formatPercent: (value: string | number | null | undefined) => string;
}) {
  return (
    <div>
      <div className="text-center mb-10">
        <div className="divider mx-auto mb-6" />
        <h2 className="text-foreground mb-4">Your Investments</h2>
        <p className="text-lg text-muted-foreground">
          Detailed view of all your investment positions
        </p>
      </div>

      <div className="space-y-4">
        {investments.map((investment) => (
          <Card key={investment.id} className="card-refined">
            <CardContent className="p-6">
              <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 flex items-center justify-center border border-border">
                    <Building2 className="w-5 h-5 text-warm-brass" />
                  </div>
                  <div>
                    <h3 className="text-lg font-serif font-medium text-foreground">
                      {investment.propertyName}
                    </h3>
                    <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground mt-1">
                      {investment.propertyAddress && (
                        <span>{investment.propertyAddress}</span>
                      )}
                      {investment.effectiveDate && (
                        <span className="flex items-center gap-1">
                          <Calendar className="h-4 w-4" />
                          {formatDate(investment.effectiveDate)}
                        </span>
                      )}
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          investment.status === "active"
                            ? "bg-green-100 text-green-700"
                            : "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {investment.status.charAt(0).toUpperCase() +
                          investment.status.slice(1)}
                      </span>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        investment.investmentType === "equity"
                          ? "bg-purple-100 text-purple-700"
                          : investment.investmentType === "deal-specific"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-gray-100 text-gray-700"
                      }`}>
                        {investment.investmentType === "equity"
                          ? "Equity Stake"
                          : investment.investmentType === "deal-specific"
                          ? "Property Loan"
                          : "General Loan"}
                      </span>
                    </div>
                    {investment.notes && (
                      <p className="text-sm text-muted-foreground mt-2 italic">
                        {investment.notes}
                      </p>
                    )}
                  </div>
                </div>

                {/* Equity Investment Details */}
                {investment.investmentType === "equity" ? (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 lg:text-right">
                    <div>
                      <div className="text-sm text-muted-foreground uppercase tracking-wider mb-1">
                        Initial Investment
                      </div>
                      <div className="text-lg font-medium text-foreground">
                        {formatCurrency(investment.initialInvestment)}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground uppercase tracking-wider mb-1">
                        Equity Stake
                      </div>
                      <div className="text-lg font-medium text-warm-brass">
                        {formatPercent(investment.equityPercentage)}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground uppercase tracking-wider mb-1">
                        Current Value
                      </div>
                      <div className="text-lg font-medium text-green-600">
                        {formatCurrency(investment.currentEquityValue)}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground uppercase tracking-wider mb-1">
                        Cash-Out @ Refi
                      </div>
                      <div className="text-lg font-medium text-foreground">
                        {formatCurrency(investment.cashOutAtRefi)}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground uppercase tracking-wider mb-1">
                        Exit Value
                      </div>
                      <div className="text-lg font-medium text-foreground">
                        {formatCurrency(investment.projectedExitValue)}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground uppercase tracking-wider mb-1">
                        Multiple
                      </div>
                      <div className="text-lg font-medium text-warm-brass">
                        {investment.equityMultiple ? `${parseFloat(investment.equityMultiple).toFixed(2)}x` : "N/A"}
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Debt Investment Details */
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-6 lg:text-right">
                    <div>
                      <div className="text-sm text-muted-foreground uppercase tracking-wider mb-1">
                        Principal
                      </div>
                      <div className="text-lg font-medium text-foreground">
                        {formatCurrency(investment.principal)}
                      </div>
                    </div>
                    {investment.balloonAmount && (
                      <div>
                        <div className="text-sm text-muted-foreground uppercase tracking-wider mb-1">
                          Balloon
                        </div>
                        <div className="text-lg font-medium text-green-600">
                          {formatCurrency(investment.balloonAmount)}
                        </div>
                      </div>
                    )}
                    {investment.monthlyPayment && (
                      <div>
                        <div className="text-sm text-muted-foreground uppercase tracking-wider mb-1">
                          Monthly
                        </div>
                        <div className="text-lg font-medium text-foreground">
                          {formatCurrency(investment.monthlyPayment)}
                        </div>
                      </div>
                    )}
                    {investment.returnMultiple && (
                      <div>
                        <div className="text-sm text-muted-foreground uppercase tracking-wider mb-1">
                          Multiple
                        </div>
                        <div className="text-lg font-medium text-warm-brass">
                          {parseFloat(investment.returnMultiple).toFixed(2)}x
                        </div>
                      </div>
                    )}
                    {investment.term && (
                      <div>
                        <div className="text-sm text-muted-foreground uppercase tracking-wider mb-1">
                          Term
                        </div>
                        <div className="text-lg font-medium text-foreground">
                          {investment.term}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}

        {investments.length === 0 && (
          <Card className="card-refined">
            <CardContent className="p-12 text-center">
              <Building2 className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">
                No Investments Yet
              </h3>
              <p className="text-muted-foreground">
                Contact us to learn about current investment opportunities.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// Properties Tab Component
function PropertiesTab({
  properties,
  investments,
  formatCurrency,
  formatPercent,
  onPropertyClick,
}: {
  properties: Property[];
  investments: Investment[];
  formatCurrency: (value: string | number | null | undefined) => string;
  formatPercent: (value: string | number | null | undefined) => string;
  onPropertyClick: (property: Property) => void;
}) {
  // Create a map of property name to investor's stake
  const investmentsByProperty = investments.reduce((acc, inv) => {
    if (!acc[inv.propertyName]) {
      acc[inv.propertyName] = [];
    }
    acc[inv.propertyName].push(inv);
    return acc;
  }, {} as Record<string, Investment[]>);

  return (
    <div>
      <div className="text-center mb-10">
        <div className="divider mx-auto mb-6" />
        <h2 className="text-foreground mb-4">Your Properties</h2>
        <p className="text-lg text-muted-foreground">
          Properties where you have an active investment
        </p>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
        {properties.map((property) => {
          const propInvestments = investmentsByProperty[property.name] || [];
          const equityInvestment = propInvestments.find(inv => inv.investmentType === "equity");

          return (
            <Card
              key={property.id}
              className="card-refined overflow-hidden cursor-pointer hover:shadow-lg transition-shadow duration-300"
              onClick={() => onPropertyClick(property)}
            >
              {/* Property Image */}
              <div className="aspect-[16/10] overflow-hidden bg-muted">
                <img
                  src={getPropertyImage(property.name)}
                  alt={property.name}
                  className="w-full h-full object-cover"
                />
              </div>

              <CardContent className="p-6">
                <h3 className="text-lg font-serif font-medium text-foreground mb-2 group-hover:text-warm-brass transition-colors">
                  {property.name}
                </h3>
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
                  <MapPin className="h-4 w-4" />
                  <span>{property.city}, {property.state}</span>
                </div>

                <div className="grid grid-cols-2 gap-4 py-4 border-y border-border mb-4">
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Units</div>
                    <div className="font-medium text-foreground">{property.units}</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">
                      {equityInvestment ? "Your Stake" : "Your Investment"}
                    </div>
                    <div className="font-medium text-warm-brass">
                      {equityInvestment
                        ? formatPercent(equityInvestment.equityPercentage)
                        : formatCurrency(propInvestments.reduce((sum, inv) => sum + parseFloat(inv.principal || "0"), 0))
                      }
                    </div>
                  </div>
                </div>

                {property.noi && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-sm text-muted-foreground mb-1">NOI</div>
                      <div className="font-medium text-foreground">{formatCurrency(property.noi)}</div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground mb-1">Cashflow</div>
                      <div className="font-medium text-green-600">{formatCurrency(property.cashflow)}</div>
                    </div>
                  </div>
                )}

                <div className="mt-4">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      property.status === "current"
                        ? "bg-green-100 text-green-700"
                        : "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {property.status === "current" ? "Active" : "Sold"}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}

        {properties.length === 0 && (
          <Card className="card-refined col-span-full">
            <CardContent className="p-12 text-center">
              <Building2 className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">
                No Properties Yet
              </h3>
              <p className="text-muted-foreground">
                Your invested properties will appear here.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// Documents Tab Component
function DocumentsTab() {
  const documentCategories = [
    {
      title: "K-1 Documents",
      description: "Annual tax documents for your investments",
      icon: FileText,
      documents: [
        { name: "2024 K-1 Form", status: "pending" },
        { name: "2023 K-1 Form", status: "available" },
      ],
    },
    {
      title: "Quarterly Reports",
      description: "Property performance updates",
      icon: TrendingUp,
      documents: [
        { name: "Q4 2024 Report", status: "pending" },
        { name: "Q3 2024 Report", status: "available" },
        { name: "Q2 2024 Report", status: "available" },
      ],
    },
    {
      title: "Investment Agreements",
      description: "Signed agreements and terms",
      icon: Briefcase,
      documents: [
        { name: "Promissory Note", status: "available" },
        { name: "Subscription Agreement", status: "available" },
      ],
    },
  ];

  return (
    <div>
      <div className="text-center mb-10">
        <div className="divider mx-auto mb-6" />
        <h2 className="text-foreground mb-4">Document Vault</h2>
        <p className="text-lg text-muted-foreground">
          Access your investment documents and reports
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-8">
        {documentCategories.map((category) => (
          <Card key={category.title} className="card-refined">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 flex items-center justify-center border border-border rounded">
                  <category.icon className="w-5 h-5 text-warm-brass" />
                </div>
                <div>
                  <CardTitle className="text-lg font-serif">{category.title}</CardTitle>
                  <p className="text-sm text-muted-foreground">{category.description}</p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-3">
                {category.documents.map((doc) => (
                  <div
                    key={doc.name}
                    className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                      doc.status === "available"
                        ? "border-border hover:border-warm-brass/50 cursor-pointer"
                        : "border-dashed border-muted-foreground/30 opacity-60"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm text-foreground">{doc.name}</span>
                    </div>
                    {doc.status === "available" ? (
                      <Download className="h-4 w-4 text-warm-brass" />
                    ) : (
                      <span className="text-xs text-muted-foreground uppercase">Coming Soon</span>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-center text-sm text-muted-foreground mt-8">
        Contact us if you need any documents not listed here.
      </p>
    </div>
  );
}

// Company Partner Dashboard Component
function CompanyPartnerDashboard({
  user,
  profile,
  metrics,
  properties,
  onPropertyClick,
}: {
  user: any;
  profile: InvestorProfile | null;
  metrics: PortfolioMetrics;
  properties: Property[];
  onPropertyClick: (property: Property) => void;
}) {
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatPercent = (value: number) => {
    return `${(value * 100).toFixed(0)}%`;
  };

  return (
    <div className="min-h-screen pt-20 bg-background">
      {/* Welcome Header */}
      <section className="py-16 bg-deep-charcoal text-white relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.02]"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          }}
        />

        <div className="container-wide relative z-10">
          <div className="divider mx-auto mb-6 bg-warm-brass" />
          <h1 className="text-white text-center mb-4">
            Welcome,{" "}
            <span className="italic text-warm-brass">{user?.firstName}</span>
          </h1>
          <p className="text-xl text-white/60 text-center max-w-2xl mx-auto font-light">
            5Central Capital Partner Dashboard
          </p>
          <div className="flex justify-center mt-4">
            <span className="px-3 py-1 bg-warm-brass/20 text-warm-brass rounded text-sm uppercase tracking-wider">
              {formatPercent(metrics.partnerEquityPercentage)} Company Partner
            </span>
          </div>
        </div>
      </section>

      {/* Portfolio Metrics */}
      <section className="section-padding bg-background">
        <div className="container-wide">
          <div className="text-center mb-10">
            <div className="divider mx-auto mb-6" />
            <h2 className="text-foreground mb-4">5Central Capital Portfolio</h2>
            <p className="text-lg text-muted-foreground">
              Your ownership stake in the total company portfolio
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
            <Card className="card-refined">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  Total Portfolio Value
                </CardTitle>
                <Building2 className="h-5 w-5 text-warm-brass" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-serif font-medium text-foreground">
                  {formatCurrency(metrics.totalValue)}
                </div>
              </CardContent>
            </Card>

            <Card className="card-refined">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  Total Equity
                </CardTitle>
                <TrendingUp className="h-5 w-5 text-warm-brass" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-serif font-medium text-foreground">
                  {formatCurrency(metrics.totalEquity)}
                </div>
              </CardContent>
            </Card>

            <Card className="card-refined bg-warm-brass/5 border-warm-brass/20">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-warm-brass uppercase tracking-wider">
                  Your Equity Value
                </CardTitle>
                <PieChart className="h-5 w-5 text-warm-brass" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-serif font-medium text-warm-brass">
                  {formatCurrency(metrics.partnerEquityValue)}
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {formatPercent(metrics.partnerEquityPercentage)} of total equity
                </p>
              </CardContent>
            </Card>

            <Card className="card-refined">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  Properties
                </CardTitle>
                <Briefcase className="h-5 w-5 text-warm-brass" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-serif font-medium text-foreground">
                  {metrics.propertyCount}
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Active holdings
                </p>
              </CardContent>
            </Card>
          </div>

          {/* All Properties Overview */}
          <div className="text-center mb-10">
            <div className="divider mx-auto mb-6" />
            <h2 className="text-foreground mb-4">Portfolio Properties</h2>
            <p className="text-lg text-muted-foreground">
              Complete view of 5Central Capital holdings
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {properties.map((property) => (
              <Card
                key={property.id}
                className="card-refined overflow-hidden cursor-pointer hover:shadow-lg transition-shadow duration-300"
                onClick={() => onPropertyClick(property)}
              >
                <div className="aspect-[16/10] overflow-hidden bg-muted">
                  <img
                    src={getPropertyImage(property.name)}
                    alt={property.name}
                    className="w-full h-full object-cover"
                  />
                </div>
                <CardContent className="p-6">
                  <h3 className="text-lg font-serif font-medium text-foreground mb-2 hover:text-warm-brass transition-colors">
                    {property.name}
                  </h3>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
                    <MapPin className="h-4 w-4" />
                    <span>{property.city}, {property.state}</span>
                  </div>

                  <div className="grid grid-cols-2 gap-4 py-4 border-y border-border mb-4">
                    <div>
                      <div className="text-sm text-muted-foreground mb-1">Units</div>
                      <div className="font-medium text-foreground">{property.units}</div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground mb-1">Current Value</div>
                      <div className="font-medium text-foreground">{formatCurrency(parseFloat(property.currentValue || "0"))}</div>
                    </div>
                  </div>

                  {property.noi && (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-sm text-muted-foreground mb-1">NOI</div>
                        <div className="font-medium text-foreground">{formatCurrency(parseFloat(property.noi || "0"))}</div>
                      </div>
                      <div>
                        <div className="text-sm text-muted-foreground mb-1">Cashflow</div>
                        <div className="font-medium text-green-600">{formatCurrency(parseFloat(property.cashflow || "0"))}</div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Contact Section */}
      <section className="section-padding bg-deep-charcoal text-white">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <div className="divider mx-auto mb-6 bg-warm-brass" />
          <h2 className="text-white mb-6">Partner Inquiries</h2>
          <p className="text-xl text-white/60 mb-12 max-w-2xl mx-auto font-light">
            For questions about your partnership or the portfolio, reach out directly.
          </p>

          <div className="grid md:grid-cols-2 gap-12 pt-12 border-t border-white/10">
            <div className="text-center">
              <Mail className="w-6 h-6 text-warm-brass mx-auto mb-3" />
              <div className="text-lg font-medium text-white mb-1">
                michael@5central.capital
              </div>
              <div className="text-sm text-white/50 uppercase tracking-wider">
                Email
              </div>
            </div>
            <div className="text-center">
              <Phone className="w-6 h-6 text-warm-brass mx-auto mb-3" />
              <div className="text-lg font-medium text-white mb-1">
                860-326-6094
              </div>
              <div className="text-sm text-white/50 uppercase tracking-wider">
                Direct Line
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
