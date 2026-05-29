import { useState } from "react";
import { Link } from "wouter";
import { type Property } from "@shared/schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getPropertyImage } from "@/lib/property-data";
import { getPublicPropertyImage, getPublicPropertyMeta } from "@/lib/public-portfolio-data";
import { StoryTimeline, VerticalStepIndicator } from "@/components/modals/StoryTimeline";
import { StepPanel } from "@/components/modals/StepPanel";
import { MetricRow, SimpleMetric } from "@/components/modals/MetricRow";
import { HighlightMetric } from "@/components/modals/HighlightMetric";
import { HeroMetricsBar } from "@/components/modals/HeroMetricsBar";
import { TimelineNode, InvestmentTimeline } from "@/components/modals/TimelineNode";
import {
  ChevronLeft,
  ChevronRight,
  MapPin,
  Calendar,
  Building2,
  TrendingUp,
  Home,
  Camera,
  ArrowUpRight,
  Landmark,
  Target
} from "lucide-react";

interface PropertyModalProps {
  property: Property | null;
  isOpen: boolean;
  onClose: () => void;
}

// Helper to safely parse decimal strings from database
const num = (val: string | number | null | undefined): number => {
  if (val === null || val === undefined) return 0;
  return typeof val === 'number' ? val : parseFloat(val) || 0;
};

// Photo Gallery Components
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
        <Camera className="w-6 h-6 text-muted-foreground/50 mb-1" />
        <span className="text-xs text-muted-foreground">Coming Soon</span>
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
            className="absolute left-1 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white p-1 rounded-full transition-colors"
          >
            <ChevronLeft className="w-3 h-3" />
          </button>
          <button
            onClick={nextPhoto}
            className="absolute right-1 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white p-1 rounded-full transition-colors"
          >
            <ChevronRight className="w-3 h-3" />
          </button>

          <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex gap-1">
            {photos.map((_, idx) => (
              <button
                key={idx}
                onClick={() => setCurrentIndex(idx)}
                className={`w-1 h-1 rounded-full transition-colors ${
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

function CompactPhotoGallery({ beforePhotos, afterPhotos, propertyName }: {
  beforePhotos: string[];
  afterPhotos: string[];
  propertyName: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 mt-2">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Before</div>
        <SingleGallery photos={beforePhotos} title={`${propertyName} Before`} />
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">After</div>
        <SingleGallery photos={afterPhotos} title={`${propertyName} After`} />
      </div>
    </div>
  );
}

// Utility functions
const formatCurrency = (value: number) => {
  if (value >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(0)}K`;
  return `$${value.toLocaleString()}`;
};

const formatPreciseCurrency = (value: number) => {
  if (value >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}K`;
  return `$${value.toLocaleString()}`;
};

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

const formatPercentChange = (before: number, after: number) => {
  if (before === 0) return "+0%";
  const change = ((after - before) / before) * 100;
  return `+${change.toFixed(0)}%`;
};

// Parse JSON photo arrays from database
const parsePhotos = (photosJson: string | null | undefined): string[] => {
  if (!photosJson) return [];
  try {
    return JSON.parse(photosJson);
  } catch {
    return [];
  }
};

// Full-width Before/After Photo Gallery for top of modal
function FullWidthPhotoGallery({ beforePhotos, afterPhotos, propertyName }: {
  beforePhotos: string[];
  afterPhotos: string[];
  propertyName: string;
}) {
  if (beforePhotos.length === 0 && afterPhotos.length === 0) {
    return null;
  }

  return (
    <div className="mb-6">
      <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
        <Camera className="w-4 h-4 text-warm-brass" />
        Before & After
      </h4>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Before</div>
          <div className="aspect-[4/3] bg-muted rounded-lg overflow-hidden">
            <SingleGallery photos={beforePhotos} title={`${propertyName} Before`} />
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">After</div>
          <div className="aspect-[4/3] bg-muted rounded-lg overflow-hidden">
            <SingleGallery photos={afterPhotos} title={`${propertyName} After`} />
          </div>
        </div>
      </div>
    </div>
  );
}

// 4-Step Investment Story Flow for Current Properties - VERTICAL LAYOUT
function InvestmentStoryFlow({ property }: { property: Property }) {
  const totalBasis = num(property.acquisitionPrice) + num(property.rehabCosts);
  const beforePhotos = parsePhotos(property.beforePhotos);
  const afterPhotos = parsePhotos(property.afterPhotos);
  const refiLoanAmount = num(property.refiLoanAmount);
  const stabilizedNOI = num(property.stabilizedNOI);
  const projectedSale = num(property.projectedSalePrice) || num(property.arvTotal);
  const debtYield = num(property.debtYield) || (refiLoanAmount > 0 ? stabilizedNOI / refiLoanAmount : 0);
  const exitCapRate = num(property.exitCapRate) || (projectedSale > 0 ? stabilizedNOI / projectedSale : 0);
  const refiTargetLabel = property.refiTargetMonth || property.refiMonth
    ? `Month ${property.refiTargetMonth || property.refiMonth}`
    : property.refiTarget || "TBD";

  return (
    <div className="space-y-6">
      {/* Investment Thesis */}
      {property.investmentThesis && (
        <div className="p-4 bg-warm-brass/5 border border-warm-brass/20 rounded-lg">
          <h4 className="text-sm font-semibold text-warm-brass mb-2 flex items-center gap-2">
            <TrendingUp className="w-4 h-4" />
            Investment Thesis
          </h4>
          <p className="text-sm text-muted-foreground leading-relaxed">{property.investmentThesis}</p>
        </div>
      )}

      {/* Before/After Photos - NOW AT TOP */}
      <FullWidthPhotoGallery
        beforePhotos={beforePhotos}
        afterPhotos={afterPhotos}
        propertyName={property.name}
      />

      {/* 4 Step Panels - VERTICAL LAYOUT */}
      <div className="space-y-4">
        {/* Step 1: Acquisition */}
        <div className="flex">
          <VerticalStepIndicator stepNumber={1} />
          <div className="flex-1">
            <StepPanel stepNumber={1} title="Acquisition" subtitle="Entry Point" icon={Home}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <SimpleMetric label="Purchase Price" value={formatCurrency(num(property.acquisitionPrice))} />
                <SimpleMetric label="Rehab Budget" value={formatCurrency(num(property.rehabCosts))} />
                <SimpleMetric label="Total Basis" value={formatCurrency(totalBasis)} highlight />
                <SimpleMetric label="Price/Unit" value={formatCurrency(num(property.entryPerUnit))} />
              </div>

              <div className="pt-3 mt-3 border-t border-border/50">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Bridge Financing</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <SimpleMetric label="Loan Amount" value={formatCurrency(num(property.bridgeLoan))} />
                  <SimpleMetric label="LTV" value={formatPercent(num(property.ltvPurchase))} />
                  <SimpleMetric label="Interest Rate" value={formatPercent(num(property.interestRate))} />
                  <SimpleMetric label="Monthly P&I" value={formatCurrency(num(property.monthlyPI))} />
                </div>
              </div>
            </StepPanel>
          </div>
        </div>

        {/* Step 2: Value Add */}
        <div className="flex">
          <VerticalStepIndicator stepNumber={2} />
          <div className="flex-1">
            <StepPanel stepNumber={2} title="Value Add" subtitle="Transformation" icon={ArrowUpRight}>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <MetricRow
                  label="Monthly Rent"
                  beforeValue={formatCurrency(num(property.inPlaceRent))}
                  afterValue={formatCurrency(num(property.proformaRent))}
                  change={formatPercentChange(num(property.inPlaceRent), num(property.proformaRent))}
                  changeType="positive"
                />
                <MetricRow
                  label="Annual NOI"
                  beforeValue={formatCurrency(num(property.inPlaceNOI))}
                  afterValue={formatCurrency(num(property.stabilizedNOI))}
                  change={`+${formatCurrency(num(property.noiUpside))}`}
                  changeType="positive"
                />
                <MetricRow
                  label="Property Value"
                  beforeValue={formatCurrency(totalBasis)}
                  afterValue={formatCurrency(num(property.arvTotal))}
                  change={`+${formatCurrency(num(property.valueCreation))}`}
                  changeType="positive"
                />
              </div>

              {/* Rent Roll Summary */}
              <div className="pt-3 mt-3 border-t border-border/50">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Rent Roll</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <SimpleMetric label="Occupied" value={`${property.occupiedUnits || 0}/${property.totalUnits || property.units}`} />
                  <SimpleMetric label="Occupancy" value={formatPercent(num(property.occupancyRate))} />
                  <SimpleMetric label="In-Place Rent" value={formatCurrency(num(property.inPlaceRent))} />
                  <SimpleMetric label="Proforma Rent" value={formatCurrency(num(property.proformaRent))} highlight />
                </div>
              </div>

              {/* Rehab Budget Breakdown */}
              <div className="pt-3 mt-3 border-t border-border/50">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Rehab Budget: {formatCurrency(num(property.rehabCosts))}</div>
                <div className="text-xs text-muted-foreground">
                  Major items: Roof, Flooring, Cabinets, Paint, Plumbing, Electrical
                </div>
              </div>
            </StepPanel>
          </div>
        </div>

        {/* Step 3: Refinance */}
        <div className="flex">
          <VerticalStepIndicator stepNumber={3} />
          <div className="flex-1">
            <StepPanel stepNumber={3} title="Refinance" subtitle="Harvest Equity" icon={Landmark}>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <SimpleMetric label="New Loan Amount" value={formatCurrency(num(property.refiLoanAmount))} />
                <SimpleMetric label="LTV (on ARV)" value={formatPercent(num(property.refiLTV) || 0.70)} />
                <SimpleMetric label="Cash-Out" value={formatCurrency(num(property.refiCashOut) || num(property.cashOutAtRefi))} highlight />
              </div>

              <div className="pt-3 mt-3 border-t border-border/50">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Post-Refi Position</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <SimpleMetric label="Equity After Refi" value={formatCurrency(num(property.equityAfterRefi))} />
                  <SimpleMetric label="New Monthly P&I" value={formatCurrency(num(property.newMonthlyPI))} />
                  <SimpleMetric label="DSCR" value={`${num(property.dscrStabilized).toFixed(2)}x`} highlight={num(property.dscrStabilized) >= 1.25} />
                  <SimpleMetric label="Debt Yield" value={formatPercent(debtYield)} />
                </div>
              </div>

              <div className="mt-3 p-2 bg-muted/30 rounded text-center">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Target: </span>
                <span className="text-xs font-medium text-foreground">{refiTargetLabel}</span>
              </div>
            </StepPanel>
          </div>
        </div>

        {/* Step 4: Exit */}
        <div className="flex">
          <VerticalStepIndicator stepNumber={4} isLast />
          <div className="flex-1">
            <StepPanel stepNumber={4} title="Exit" subtitle="Realize Returns" icon={Target} highlight>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <SimpleMetric label="Exit Cap Rate" value={formatPercent(exitCapRate)} />
                <SimpleMetric label="Projected Sale" value={formatCurrency(num(property.projectedSalePrice) || num(property.arvTotal))} />
                <SimpleMetric label="Net Proceeds" value={formatCurrency(num(property.projectedNetProceeds) || num(property.netCashFromSale))} />
              </div>

              <div className="pt-4 mt-4 border-t border-warm-brass/30">
                <div className="text-[10px] uppercase tracking-wider text-warm-brass mb-3 font-medium">Final Returns</div>
                <div className="grid grid-cols-3 gap-4">
                  <HighlightMetric label="IRR" value={property.irrLevered || "N/A"} size="sm" variant="featured" />
                  <HighlightMetric label="MOIC" value={`${num(property.moic).toFixed(2)}x`} size="sm" variant="featured" />
                  <HighlightMetric
                    label="Total Profit"
                    value={formatCurrency(num(property.projectedTotalProfit) || num(property.totalProfit))}
                    size="sm"
                    variant="featured"
                  />
                </div>
              </div>

              <div className="mt-3 p-2 bg-warm-brass/10 rounded text-center">
                <span className="text-[10px] uppercase tracking-wider text-warm-brass">Hold Period: </span>
                <span className="text-xs font-medium text-warm-brass">{property.holdPeriodMonths || 24} Months</span>
              </div>
            </StepPanel>
          </div>
        </div>
      </div>

      {/* Deal Overview Footer */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-4 border-t border-border">
        <div className="text-center">
          <div className="text-xs text-muted-foreground">Location</div>
          <div className="text-sm font-medium">{property.city}, {property.state}</div>
        </div>
        <div className="text-center">
          <div className="text-xs text-muted-foreground">Year Built</div>
          <div className="text-sm font-medium">{property.yearBuilt || "Various"}</div>
        </div>
        <div className="text-center">
          <div className="text-xs text-muted-foreground">Units</div>
          <div className="text-sm font-medium">{property.totalUnits || property.units}</div>
        </div>
        <div className="text-center">
          <div className="text-xs text-muted-foreground">Occupancy</div>
          <div className="text-sm font-medium">{formatPercent(num(property.occupancyRate))}</div>
        </div>
      </div>
    </div>
  );
}

// Elegant Sold Property View with Timeline
function SoldPropertyTimelineView({ property }: { property: Property }) {
  const acquisitionDate = new Date(property.acquisitionDate);
  const saleDate = property.saleDate ? new Date(property.saleDate) : new Date();
  const yearsHeld = ((saleDate.getTime() - acquisitionDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25)).toFixed(1);

  const acquiredDateStr = acquisitionDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const soldDateStr = saleDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

  return (
    <div className="space-y-6">
      {/* Hero Metrics */}
      <HeroMetricsBar
        metrics={[
          { label: "IRR", value: `${num(property.irr).toFixed(1)}%`, highlight: true },
          { label: "Equity Multiple", value: `${num(property.equityMultiple).toFixed(2)}x`, highlight: true },
          { label: "Total Profit", value: formatCurrency(num(property.totalProfit)), highlight: true },
        ]}
      />

      {/* Investment Journey Timeline */}
      <InvestmentTimeline>
        <TimelineNode
          type="acquired"
          title={acquiredDateStr}
          metrics={[
            { label: "Purchase Price", value: formatCurrency(num(property.acquisitionPrice)) },
            { label: "Rehab Investment", value: formatCurrency(num(property.rehabCosts)) },
            { label: "Total Basis", value: formatCurrency(num(property.totalBasis)) },
            { label: "Initial Capital", value: formatCurrency(num(property.initialCapitalRequired)) },
          ]}
        />

        <TimelineNode
          type="held"
          title={`${yearsHeld} Years`}
          metrics={[
            { label: "Total Cashflow", value: formatCurrency(num(property.totalCashflowCollected)) },
            { label: "Cash-on-Cash", value: `${num(property.cashOnCash).toFixed(1)}%` },
            { label: "Avg Annual Return", value: `${num(property.avgAnnualReturn).toFixed(1)}%` },
          ]}
        />

        <TimelineNode
          type="sold"
          title={soldDateStr}
          isLast
          metrics={[
            { label: "Sale Price", value: formatCurrency(num(property.salePrice)), highlight: true },
            { label: "Appreciation", value: `+${num(property.appreciationPercent).toFixed(1)}%`, highlight: true },
            { label: "Sale Proceeds", value: formatCurrency(num(property.saleProceeds)) },
            { label: "Total Return", value: `${num(property.totalReturnPercent).toFixed(1)}%`, highlight: true },
          ]}
        />
      </InvestmentTimeline>

      {/* Per Unit Analysis */}
      <div className="grid grid-cols-3 gap-3 pt-4 border-t border-border">
        <div className="text-center p-3 bg-muted/30 rounded-lg">
          <div className="text-xs text-muted-foreground mb-1">Buy Price/Unit</div>
          <div className="text-sm font-medium">{formatCurrency(num(property.acquisitionPrice) / property.units)}</div>
        </div>
        <div className="text-center p-3 bg-muted/30 rounded-lg">
          <div className="text-xs text-muted-foreground mb-1">Sell Price/Unit</div>
          <div className="text-sm font-medium">{formatCurrency(num(property.pricePerUnit))}</div>
        </div>
        <div className="text-center p-3 bg-warm-brass/10 border border-warm-brass/20 rounded-lg">
          <div className="text-xs text-muted-foreground mb-1">Profit/Unit</div>
          <div className="text-sm font-medium text-warm-brass">{formatCurrency(num(property.profitPerUnit))}</div>
        </div>
      </div>
    </div>
  );
}

function FlipProjectView({ property }: { property: Property }) {
  const sensitivity = [
    { label: "Low", sale: 550_000, closingCash: 100_462.01, profit: 27_587.01 },
    { label: "Base", sale: 575_000, closingCash: 123_712.01, profit: 50_837.01 },
    { label: "Target", sale: 600_000, closingCash: 146_962.01, profit: 74_087.01 },
  ];

  return (
    <div className="space-y-6">
      <div className="mb-6 aspect-[21/9] bg-muted rounded-lg overflow-hidden">
        <img
          src={getPublicPropertyImage(property)}
          alt={property.name}
          className="w-full h-full object-cover"
        />
      </div>

      {property.investmentThesis && (
        <div className="p-4 bg-warm-brass/5 border border-warm-brass/20 rounded-lg">
          <h4 className="text-sm font-semibold text-warm-brass mb-2 flex items-center gap-2">
            <TrendingUp className="w-4 h-4" />
            Project Thesis
          </h4>
          <p className="text-sm text-muted-foreground leading-relaxed">{property.investmentThesis}</p>
        </div>
      )}

      <HeroMetricsBar
        metrics={[
          { label: "Target Sale", value: formatPreciseCurrency(num(property.projectedSalePrice) || num(property.currentValue)), highlight: true },
          { label: "Cash To 5Central", value: formatPreciseCurrency(num(property.projectedNetProceeds)), highlight: true },
          { label: "Full Project Profit", value: formatPreciseCurrency(num(property.projectedTotalProfit) || num(property.totalProfit)), highlight: true },
          { label: "ROI", value: `${num(property.cashOnCash).toFixed(1)}%`, highlight: true },
        ]}
      />

      <div className="grid md:grid-cols-2 gap-4">
        <div className="panel-summary p-5">
          <h4 className="text-sm uppercase tracking-[0.2em] text-muted-foreground mb-4">Project Capital</h4>
          <div className="grid grid-cols-2 gap-4">
            <SimpleMetric label="Payoff" value={formatPreciseCurrency(num(property.acquisitionPrice))} />
            <SimpleMetric label="Rehab Budget" value={formatPreciseCurrency(num(property.rehabCosts))} />
            <SimpleMetric label="Cash Due At Purchase" value={formatPreciseCurrency(9_700)} />
            <SimpleMetric label="Rehab Gap" value={formatPreciseCurrency(35_000)} />
            <SimpleMetric label="Holding Interest" value={formatPreciseCurrency(28_175)} />
            <SimpleMetric label="Total Contribution" value={formatPreciseCurrency(num(property.initialCapitalRequired))} highlight />
          </div>
        </div>

        <div className="panel-summary p-5">
          <h4 className="text-sm uppercase tracking-[0.2em] text-muted-foreground mb-4">Exit Case</h4>
          <div className="grid grid-cols-2 gap-4">
            <SimpleMetric label="Base Hold" value={`${property.holdPeriodMonths || 7} months`} />
            <SimpleMetric label="Draw Reimbursement" value={formatPreciseCurrency(60_000)} />
            <SimpleMetric label="Closing Cash" value={formatPreciseCurrency(num(property.projectedNetProceeds))} highlight />
            <SimpleMetric label="Project Profit" value={formatPreciseCurrency(num(property.totalProfit))} highlight />
          </div>
          <p className="text-xs text-muted-foreground mt-4 border-t border-border pt-4">
            Public view shows full project economics only. Partner splits are intentionally not shown.
          </p>
        </div>
      </div>

      <div className="panel-summary p-5">
        <h4 className="text-sm uppercase tracking-[0.2em] text-muted-foreground mb-4">Sale Price Sensitivity</h4>
        <div className="grid md:grid-cols-3 gap-4">
          {sensitivity.map((item) => (
            <div key={item.label} className="border border-border bg-background p-4">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-3">{item.label} Case</div>
              <div className="space-y-3">
                <SimpleMetric label="Sale Price" value={formatPreciseCurrency(item.sale)} />
                <SimpleMetric label="Closing Cash" value={formatPreciseCurrency(item.closingCash)} />
                <SimpleMetric label="Profit" value={formatPreciseCurrency(item.profit)} highlight />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Main Property Modal
export default function PropertyModal({ property, isOpen, onClose }: PropertyModalProps) {
  if (!property) return null;
  const meta = getPublicPropertyMeta(property);
  const isFlip = meta?.assetClass === "single_family_flip";

  const acquisitionDate = new Date(property.acquisitionDate);
  const formattedDate = acquisitionDate.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric'
  });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="p-6 pb-4">
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
                  {isFlip ? "Single-family flip" : `${property.units} Units`}
                </span>
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-4 h-4" />
                  {isFlip ? "Started" : "Acquired"} {formattedDate}
                </span>
              </div>
              {meta?.slug && (
                <Link href={`/portfolio/${meta.slug}`} className="inline-flex mt-3 text-xs uppercase tracking-[0.18em] text-warm-brass hover:underline">
                  Open asset page
                </Link>
              )}
            </div>
            {isFlip ? (
              <span className="px-3 py-1 text-xs uppercase tracking-wider rounded-full bg-warm-brass/10 text-warm-brass border border-warm-brass/20">
                Active Flip
              </span>
            ) : property.status === "sold" && (
              <span className="px-3 py-1 text-xs uppercase tracking-wider rounded-full bg-warm-brass/10 text-warm-brass border border-warm-brass/20">
                Sold
              </span>
            )}
          </div>
        </DialogHeader>

        <div className="px-6 pb-6">
          {/* Property image for sold properties */}
          {property.status === "sold" && (
            <div className="mb-6 aspect-[21/9] bg-muted rounded-lg overflow-hidden">
              <img
                src={getPropertyImage(property.name)}
                alt={property.name}
                className="w-full h-full object-cover"
              />
            </div>
          )}

          {/* Details Section */}
          {isFlip ? (
            <FlipProjectView property={property} />
          ) : property.status === "current" ? (
            <InvestmentStoryFlow property={property} />
          ) : (
            <SoldPropertyTimelineView property={property} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
