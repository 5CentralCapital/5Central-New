import { useState } from "react";
import { type Property } from "@shared/schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getPropertyDetails, getSoldPropertyDetails, type PropertyDetails, type SoldPropertyDetails } from "@/lib/property-details";
import { getPropertyImage } from "@/lib/property-data";
import {
  ChevronLeft,
  ChevronRight,
  MapPin,
  Calendar,
  Building2,
  TrendingUp,
  DollarSign,
  Percent,
  BarChart3,
  Home,
  Camera
} from "lucide-react";

interface PropertyModalProps {
  property: Property | null;
  isOpen: boolean;
  onClose: () => void;
}

function SingleGallery({ photos, title }: { photos: string[]; title: string }) {
  const [currentIndex, setCurrentIndex] = useState(0);

  const nextPhoto = () => {
    setCurrentIndex((prev) => (prev + 1) % photos.length);
  };

  const prevPhoto = () => {
    setCurrentIndex((prev) => (prev - 1 + photos.length) % photos.length);
  };

  if (!photos || photos.length === 0) {
    return (
      <div className="aspect-[4/3] bg-muted/50 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border">
        <Camera className="w-8 h-8 text-muted-foreground/50 mb-2" />
        <span className="text-sm text-muted-foreground">Coming Soon</span>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="aspect-[4/3] bg-muted rounded-lg overflow-hidden">
        <img
          src={photos[currentIndex]}
          alt={`${title} - Photo ${currentIndex + 1}`}
          className="w-full h-full object-cover"
        />
      </div>

      {photos.length > 1 && (
        <>
          <button
            onClick={prevPhoto}
            className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white p-1.5 rounded-full transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={nextPhoto}
            className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white p-1.5 rounded-full transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1.5">
            {photos.map((_, idx) => (
              <button
                key={idx}
                onClick={() => setCurrentIndex(idx)}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  idx === currentIndex ? "bg-white" : "bg-white/50"
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function PhotoGallery({ beforePhotos, afterPhotos, propertyName }: {
  beforePhotos: string[];
  afterPhotos: string[];
  propertyName: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <h4 className="text-sm font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Before</h4>
        <SingleGallery photos={beforePhotos} title={`${propertyName} Before`} />
      </div>
      <div>
        <h4 className="text-sm font-semibold text-muted-foreground mb-2 uppercase tracking-wider">After</h4>
        <SingleGallery photos={afterPhotos} title={`${propertyName} After`} />
      </div>
    </div>
  );
}

function MetricCard({ label, value, prefix = "", suffix = "", highlight = false }: {
  label: string;
  value: string | number;
  prefix?: string;
  suffix?: string;
  highlight?: boolean;
}) {
  return (
    <div className={`p-4 rounded-lg ${highlight ? "bg-warm-brass/10 border border-warm-brass/20" : "bg-muted/50"}`}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      <div className={`text-lg font-semibold ${highlight ? "text-warm-brass" : "text-foreground"}`}>
        {prefix}{typeof value === "number" ? value.toLocaleString() : value}{suffix}
      </div>
    </div>
  );
}

function CurrentPropertyDetails({ property, details }: { property: Property; details: PropertyDetails }) {
  const formatCurrency = (value: number) => {
    if (value >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
    if (value >= 1000) return `$${(value / 1000).toFixed(0)}K`;
    return `$${value.toLocaleString()}`;
  };

  const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

  return (
    <Tabs defaultValue="overview" className="w-full">
      <TabsList className="grid w-full grid-cols-4 mb-6">
        <TabsTrigger value="overview" className="text-xs">Overview</TabsTrigger>
        <TabsTrigger value="financials" className="text-xs">Financials</TabsTrigger>
        <TabsTrigger value="returns" className="text-xs">Returns</TabsTrigger>
        <TabsTrigger value="debt" className="text-xs">Debt</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="space-y-6">
        {/* Investment Thesis */}
        {details.investmentThesis && (
          <div className="p-4 bg-warm-brass/5 border border-warm-brass/20 rounded-lg">
            <h4 className="text-sm font-semibold text-warm-brass mb-2 flex items-center gap-2">
              <TrendingUp className="w-4 h-4" />
              Investment Thesis
            </h4>
            <p className="text-sm text-muted-foreground">{details.investmentThesis}</p>
          </div>
        )}

        {/* Deal Overview */}
        <div>
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Building2 className="w-4 h-4" />
            Deal Overview
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard label="Location" value={details.location} />
            <MetricCard label="Year Built" value={details.yearBuilt} />
            <MetricCard label="Units" value={property.units} />
            <MetricCard label="Closing Date" value={details.closingDate} />
          </div>
        </div>

        {/* Rent Roll Summary */}
        <div>
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Home className="w-4 h-4" />
            Rent Roll Summary
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <MetricCard label="Occupancy" value={formatPercent(details.occupancyRate)} highlight={details.occupancyRate >= 0.9} />
            <MetricCard label="In-Place Rent" value={formatCurrency(details.inPlaceRent)} suffix="/mo" />
            <MetricCard label="Proforma Rent" value={formatCurrency(details.proformaRent)} suffix="/mo" />
            <MetricCard label="Rent Upside" value={formatCurrency(details.rentUpside)} suffix="/mo" highlight />
            <MetricCard label="Occupied Units" value={`${details.occupiedUnits} / ${details.totalUnits}`} />
            <MetricCard label="Stabilized Occ" value="95%" />
          </div>
        </div>
      </TabsContent>

      <TabsContent value="financials" className="space-y-6">
        {/* Acquisition Metrics */}
        <div>
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <DollarSign className="w-4 h-4" />
            Acquisition Metrics
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <MetricCard label="Purchase Price" value={formatCurrency(parseFloat(property.acquisitionPrice))} />
            <MetricCard label="Rehab Budget" value={formatCurrency(parseFloat(property.rehabCosts || "0"))} />
            <MetricCard label="Total Basis" value={formatCurrency(parseFloat(property.acquisitionPrice) + parseFloat(property.rehabCosts || "0"))} />
            <MetricCard label="Price/Unit" value={formatCurrency(details.entryPerUnit)} />
            <MetricCard label="In-Place NOI" value={formatCurrency(details.inPlaceNOI)} />
            <MetricCard label="Stabilized NOI" value={formatCurrency(details.stabilizedNOI)} highlight />
          </div>
        </div>

        {/* Valuation Analysis */}
        <div>
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />
            Valuation Analysis
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <MetricCard label="Entry Cap Rate" value={formatPercent(details.entryCapRate)} />
            <MetricCard label="Exit Cap Rate" value={formatPercent(details.exitCapRate)} />
            <MetricCard label="ARV" value={formatCurrency(details.arvTotal)} highlight />
            <MetricCard label="ARV/Unit" value={formatCurrency(details.arvPerUnit)} />
            <MetricCard label="Value Creation" value={formatCurrency(details.valueCreation)} highlight />
            <MetricCard label="NOI Upside" value={formatCurrency(details.noiUpside)} />
          </div>
        </div>
      </TabsContent>

      <TabsContent value="returns" className="space-y-6">
        {/* Key Returns */}
        <div>
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <TrendingUp className="w-4 h-4" />
            Key Returns
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <MetricCard label="IRR (Levered)" value={details.irrLevered} highlight />
            <MetricCard label="MOIC" value={details.moic.toFixed(2)} suffix="x" highlight />
            <MetricCard label="Yield on Cost" value={formatPercent(details.yieldOnCost)} />
            <MetricCard label="Cash Yield" value={formatPercent(details.cashYieldStabilized)} />
            <MetricCard label="Payback Period" value={details.paybackPeriod.toFixed(1)} suffix=" mo" />
            <MetricCard label="Hold Period" value={details.holdPeriod} />
          </div>
        </div>

        {/* Exit Analysis */}
        <div>
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <DollarSign className="w-4 h-4" />
            Exit Analysis
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <MetricCard label="Sponsor Equity" value={formatCurrency(details.sponsorEquity)} />
            <MetricCard label="Cash-Out at Refi" value={formatCurrency(details.cashOutAtRefi)} />
            <MetricCard label="Net Cash from Sale" value={formatCurrency(details.netCashFromSale)} />
            <MetricCard label="Total Profit" value={formatCurrency(details.totalProfit)} highlight />
            <MetricCard label="Refi Month" value={`Month ${details.refiMonth}`} />
            <MetricCard label="Exit $/Unit" value={formatCurrency(details.exitPerUnit)} />
          </div>
        </div>

        {/* Risk Metrics */}
        <div>
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Percent className="w-4 h-4" />
            Risk Metrics
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <MetricCard label="Break-Even Occ" value={formatPercent(details.breakevenOccupancy)} />
            <MetricCard label="DSCR (Stabilized)" value={details.dscrStabilized.toFixed(2)} suffix="x" highlight={details.dscrStabilized >= 1.25} />
            <MetricCard label="Debt Yield" value={formatPercent(details.debtYield)} />
          </div>
        </div>
      </TabsContent>

      <TabsContent value="debt" className="space-y-6">
        {/* Financing Summary */}
        <div>
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <DollarSign className="w-4 h-4" />
            Financing Summary
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <MetricCard label="Bridge Loan" value={formatCurrency(details.bridgeLoan)} />
            <MetricCard label="Rehab Holdback" value={formatCurrency(details.rehabHoldback)} />
            <MetricCard label="Total Commitment" value={formatCurrency(details.totalCommitment)} />
            <MetricCard label="LTV (Purchase)" value={formatPercent(details.ltvPurchase)} />
            <MetricCard label="LTC" value={formatPercent(details.ltc)} />
            <MetricCard label="Interest Rate" value={formatPercent(details.interestRate)} />
          </div>
        </div>

        {/* Current Debt Position */}
        <div>
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />
            Current Debt Position
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <MetricCard label="Current Debt" value={formatCurrency(details.currentDebt)} />
            <MetricCard label="Monthly P&I" value={formatCurrency(details.monthlyPI)} />
            <MetricCard label="Annual Debt Service" value={formatCurrency(details.annualDebtService)} />
            <MetricCard label="Maturity" value={details.maturityDate} highlight />
            <MetricCard label="Loan Type" value={details.loanType} />
            <MetricCard label="Current LTV" value={formatPercent(details.currentDebt / details.arvTotal)} />
          </div>
        </div>
      </TabsContent>
    </Tabs>
  );
}

function SoldPropertyDetailsView({ property, details }: { property: Property; details: SoldPropertyDetails }) {
  const formatCurrency = (value: number) => {
    if (value >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
    if (value >= 1000) return `$${Math.round(value / 1000)}K`;
    return `$${value.toLocaleString()}`;
  };

  // Calculate years held
  const acquisitionDate = new Date(property.acquisitionDate);
  const saleDate = property.saleDate ? new Date(property.saleDate) : new Date();
  const yearsHeld = ((saleDate.getTime() - acquisitionDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25)).toFixed(1);

  return (
    <div className="space-y-6">
      {/* Deal Summary */}
      <div>
        <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Building2 className="w-4 h-4" />
          Deal Summary
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="Purchase Price" value={formatCurrency(parseFloat(property.acquisitionPrice))} />
          <MetricCard label="Rehab Costs" value={formatCurrency(parseFloat(property.rehabCosts || "0"))} />
          <MetricCard label="Total Basis" value={formatCurrency(details.totalBasis)} />
          <MetricCard label="Sale Price" value={formatCurrency(parseFloat(property.salePrice || "0"))} highlight />
        </div>
      </div>

      {/* Investment Performance */}
      <div>
        <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <TrendingUp className="w-4 h-4" />
          Investment Performance
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="Initial Capital" value={formatCurrency(details.initialCapitalRequired)} />
          <MetricCard label="Total Cashflow" value={formatCurrency(details.totalCashflowCollected)} />
          <MetricCard label="Sale Proceeds" value={formatCurrency(details.saleProceeds)} />
          <MetricCard label="Total Profit" value={formatCurrency(details.totalProfit)} highlight />
        </div>
      </div>

      {/* Return Metrics */}
      <div>
        <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Percent className="w-4 h-4" />
          Return Metrics
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="IRR" value={`${parseFloat(property.irr || "0").toFixed(1)}%`} highlight />
          <MetricCard label="Equity Multiple" value={`${parseFloat(property.equityMultiple || "0").toFixed(2)}x`} highlight />
          <MetricCard label="Cash-on-Cash" value={`${details.cashOnCash.toFixed(1)}%`} />
          <MetricCard label="Total Return" value={`${details.totalReturnPercent.toFixed(1)}%`} />
          <MetricCard label="Appreciation" value={`${details.appreciationPercent.toFixed(1)}%`} />
          <MetricCard label="Avg Annual Return" value={`${details.avgAnnualReturn.toFixed(1)}%`} />
          <MetricCard label="Years Held" value={yearsHeld} />
          <MetricCard label="Profit/Unit" value={formatCurrency(details.profitPerUnit)} />
        </div>
      </div>

      {/* Per Unit Analysis */}
      <div>
        <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Home className="w-4 h-4" />
          Per Unit Analysis
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <MetricCard label="Price/Unit (Buy)" value={formatCurrency(parseFloat(property.acquisitionPrice) / property.units)} />
          <MetricCard label="Price/Unit (Sell)" value={formatCurrency(details.pricePerUnit)} />
          <MetricCard label="Profit/Unit" value={formatCurrency(details.profitPerUnit)} highlight />
        </div>
      </div>
    </div>
  );
}

export default function PropertyModal({ property, isOpen, onClose }: PropertyModalProps) {
  if (!property) return null;

  const details = property.status === "current"
    ? getPropertyDetails(property.name)
    : null;

  const soldDetails = property.status === "sold"
    ? getSoldPropertyDetails(property.name)
    : null;

  const acquisitionDate = new Date(property.acquisitionDate);
  const formattedDate = acquisitionDate.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric'
  });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="p-6 pb-0">
          <div className="flex items-start justify-between">
            <div>
              <DialogTitle className="text-2xl font-serif font-medium text-foreground">
                {property.name}
              </DialogTitle>
              <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-4 h-4" />
                  {property.city}, {property.state}
                </span>
                <span className="flex items-center gap-1.5">
                  <Building2 className="w-4 h-4" />
                  {property.units} Units
                </span>
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-4 h-4" />
                  Acquired {formattedDate}
                </span>
              </div>
            </div>
            {property.status === "sold" && (
              <span className="px-3 py-1 text-xs uppercase tracking-wider rounded-full bg-muted text-muted-foreground">
                Sold
              </span>
            )}
          </div>
        </DialogHeader>

        <div className="p-6">
          {/* Photo Gallery - Only for current properties */}
          {property.status === "current" && details && (
            <div className="mb-6">
              <PhotoGallery
                beforePhotos={details.beforePhotos || []}
                afterPhotos={details.afterPhotos || []}
                propertyName={property.name}
              />
            </div>
          )}

          {/* Property image for sold properties */}
          {property.status === "sold" && (
            <div className="mb-6 aspect-[16/9] bg-muted rounded-lg overflow-hidden">
              <img
                src={getPropertyImage(property.name)}
                alt={property.name}
                className="w-full h-full object-cover"
              />
            </div>
          )}

          {/* Details Section */}
          {property.status === "current" && details ? (
            <CurrentPropertyDetails property={property} details={details} />
          ) : soldDetails ? (
            <SoldPropertyDetailsView property={property} details={soldDetails} />
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Detailed information not available for this property.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
