import { useState } from "react";
import { type Property } from "@shared/schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getPropertyImage } from "@/lib/property-data";
import { StoryTimeline } from "@/components/modals/StoryTimeline";
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

// 4-Step Investment Story Flow for Current Properties
function InvestmentStoryFlow({ property }: { property: Property }) {
  const steps = [
    { number: 1, title: "Acquisition" },
    { number: 2, title: "Value Add" },
    { number: 3, title: "Refinance" },
    { number: 4, title: "Exit" },
  ];

  const totalBasis = num(property.acquisitionPrice) + num(property.rehabCosts);
  const beforePhotos = parsePhotos(property.beforePhotos);
  const afterPhotos = parsePhotos(property.afterPhotos);

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

      {/* Timeline */}
      <StoryTimeline steps={steps} />

      {/* 4 Step Panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Step 1: Acquisition */}
        <StepPanel stepNumber={1} title="Acquisition" subtitle="Entry Point" icon={Home}>
          <SimpleMetric label="Purchase Price" value={formatCurrency(num(property.acquisitionPrice))} />
          <SimpleMetric label="Rehab Budget" value={formatCurrency(num(property.rehabCosts))} />
          <SimpleMetric label="Total Basis" value={formatCurrency(totalBasis)} highlight />
          <SimpleMetric label="Price/Unit" value={formatCurrency(num(property.entryPerUnit))} />

          <div className="pt-2 mt-2 border-t border-border/50">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Bridge Financing</div>
            <SimpleMetric label="Loan Amount" value={formatCurrency(num(property.bridgeLoan))} />
            <SimpleMetric label="LTV" value={formatPercent(num(property.ltvPurchase))} />
            <SimpleMetric label="Interest Rate" value={formatPercent(num(property.interestRate))} />
            <SimpleMetric label="Monthly P&I" value={formatCurrency(num(property.monthlyPI))} />
          </div>
        </StepPanel>

        {/* Step 2: Value Add */}
        <StepPanel stepNumber={2} title="Value Add" subtitle="Transformation" icon={ArrowUpRight}>
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

          {/* Compact Before/After Photos */}
          {(beforePhotos.length > 0 || afterPhotos.length > 0) && (
            <CompactPhotoGallery
              beforePhotos={beforePhotos}
              afterPhotos={afterPhotos}
              propertyName={property.name}
            />
          )}
        </StepPanel>

        {/* Step 3: Refinance */}
        <StepPanel stepNumber={3} title="Refinance" subtitle="Harvest Equity" icon={Landmark}>
          <SimpleMetric label="New Loan Amount" value={formatCurrency(num(property.refiLoanAmount))} />
          <SimpleMetric label="LTV (on ARV)" value={formatPercent(num(property.refiLTV) || 0.70)} />
          <SimpleMetric label="Cash-Out" value={formatCurrency(num(property.refiCashOut) || num(property.cashOutAtRefi))} highlight />

          <div className="pt-2 mt-2 border-t border-border/50">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Post-Refi Position</div>
            <SimpleMetric label="Equity After Refi" value={formatCurrency(num(property.equityAfterRefi))} />
            <SimpleMetric label="New Monthly P&I" value={formatCurrency(num(property.newMonthlyPI))} />
            <SimpleMetric label="DSCR" value={`${num(property.dscrStabilized).toFixed(2)}x`} highlight={num(property.dscrStabilized) >= 1.25} />
            <SimpleMetric label="Debt Yield" value={formatPercent(num(property.debtYield))} />
          </div>

          <div className="mt-2 p-2 bg-muted/30 rounded text-center">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Target: </span>
            <span className="text-xs font-medium text-foreground">Month {property.refiTargetMonth || property.refiMonth}</span>
          </div>
        </StepPanel>

        {/* Step 4: Exit */}
        <StepPanel stepNumber={4} title="Exit" subtitle="Realize Returns" icon={Target} highlight>
          <SimpleMetric label="Exit Cap Rate" value={formatPercent(num(property.exitCapRate))} />
          <SimpleMetric label="Projected Sale" value={formatCurrency(num(property.projectedSalePrice) || num(property.arvTotal))} />
          <SimpleMetric label="Net Proceeds" value={formatCurrency(num(property.projectedNetProceeds) || num(property.netCashFromSale))} />

          <div className="pt-3 mt-3 border-t border-warm-brass/30">
            <div className="text-[10px] uppercase tracking-wider text-warm-brass mb-2 font-medium">Final Returns</div>
            <div className="grid grid-cols-2 gap-2">
              <HighlightMetric label="IRR" value={property.irrLevered || "N/A"} size="sm" variant="featured" />
              <HighlightMetric label="MOIC" value={`${num(property.moic).toFixed(2)}x`} size="sm" variant="featured" />
            </div>
            <div className="mt-2">
              <HighlightMetric
                label="Total Profit"
                value={formatCurrency(num(property.projectedTotalProfit) || num(property.totalProfit))}
                size="md"
                variant="featured"
              />
            </div>
          </div>

          <div className="mt-2 p-2 bg-warm-brass/10 rounded text-center">
            <span className="text-[10px] uppercase tracking-wider text-warm-brass">Hold Period: </span>
            <span className="text-xs font-medium text-warm-brass">{property.holdPeriodMonths || 24} Months</span>
          </div>
        </StepPanel>
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

// Main Property Modal
export default function PropertyModal({ property, isOpen, onClose }: PropertyModalProps) {
  if (!property) return null;

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
                  {property.units} Units
                </span>
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-4 h-4" />
                  Acquired {formattedDate}
                </span>
              </div>
            </div>
            {property.status === "sold" && (
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
          {property.status === "current" ? (
            <InvestmentStoryFlow property={property} />
          ) : (
            <SoldPropertyTimelineView property={property} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
