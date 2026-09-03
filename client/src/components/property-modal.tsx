import { useState } from "react";
import { Link } from "wouter";
import { type Property } from "@shared/schema";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getPublicPropertyImage, getPublicPropertyMeta } from "@/lib/public-portfolio-data";
import { SimpleMetric } from "@/components/modals/MetricRow";
import { HeroMetricsBar } from "@/components/modals/HeroMetricsBar";
import { TimelineNode, InvestmentTimeline } from "@/components/modals/TimelineNode";
import {
  ChevronLeft,
  ChevronRight,
  MapPin,
  Calendar,
  Building2,
  TrendingUp,
  Camera,
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

const formatExactCurrency = (value: number) => {
  const hasCents = Math.abs(value - Math.round(value)) > 0.001;
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
};

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

const formatSignedCurrency = (value: number) =>
  value < 0 ? `-${formatExactCurrency(Math.abs(value))}` : formatExactCurrency(value);

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

// Property-level operating and underwriting totals for current holdings.
function InvestmentStoryFlow({ property }: { property: Property }) {
  const totalBasis = num(property.totalBasis) || num(property.acquisitionPrice) + num(property.rehabCosts);
  const beforePhotos = parsePhotos(property.beforePhotos);
  const afterPhotos = parsePhotos(property.afterPhotos);
  const propertyValue = num(property.currentValue) || num(property.arvTotal);
  const underwrittenNOI = num(property.stabilizedNOI) || num(property.noi);
  const capRate = num(property.exitCapRate) || (propertyValue > 0 ? underwrittenNOI / propertyValue : 0);
  const currentDebt = num(property.currentDebt);
  const annualDebtService = num(property.annualDebtService) || num(property.debtService);
  const monthlyDebtService = annualDebtService > 0 ? annualDebtService / 12 : num(property.monthlyPI);
  const currentLTV = propertyValue > 0 ? currentDebt / propertyValue : 0;
  const propertyEquity = Math.max(0, propertyValue - currentDebt);
  const modeledLoan = num(property.refiLoanAmount);
  const hasIncrementalLenderScenario = modeledLoan > currentDebt + 1;
  const valueLabel = property.id === "mlk-apartments" ? "Appraised Value" : "Underwritten Value";
  const debtLabel = property.id === "lucia-apartments" ? "Underwritten Loan" : "Debt Balance";
  const debtServiceLabel = hasIncrementalLenderScenario
    ? "Modeled Monthly Debt Service"
    : property.id === "lucia-apartments"
      ? "Underwritten Monthly Debt Service"
      : "Monthly Debt Service";
  const cashflowLabel = hasIncrementalLenderScenario
    ? "NOI Less Modeled Debt Service"
    : property.id === "lucia-apartments"
      ? "NOI Less Underwritten Debt Service"
      : "NOI Less Debt Service";

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

      <FullWidthPhotoGallery
        beforePhotos={beforePhotos}
        afterPhotos={afterPhotos}
        propertyName={property.name}
      />

      <HeroMetricsBar
        metrics={[
          { label: valueLabel, value: formatExactCurrency(propertyValue), highlight: true },
          { label: "Underwritten NOI", value: formatExactCurrency(underwrittenNOI), highlight: true },
          { label: "Cap Rate", value: formatPercent(capRate), highlight: true },
          { label: "Occupancy", value: formatPercent(num(property.occupancyRate)), highlight: true },
        ]}
      />

      <div className="grid md:grid-cols-2 gap-4">
        <div className="panel-summary p-5">
          <h4 className="text-sm uppercase tracking-[0.2em] text-muted-foreground mb-4">Project Totals</h4>
          <div className="grid grid-cols-2 gap-4">
            <SimpleMetric label="Purchase Price" value={formatExactCurrency(num(property.acquisitionPrice))} />
            <SimpleMetric label="CapEx" value={formatExactCurrency(num(property.rehabCosts))} />
            <SimpleMetric label="Total Basis" value={formatExactCurrency(totalBasis)} highlight />
            <SimpleMetric label="Value Creation" value={formatExactCurrency(num(property.valueCreation))} highlight />
          </div>
        </div>

        <div className="panel-summary p-5">
          <h4 className="text-sm uppercase tracking-[0.2em] text-muted-foreground mb-4">Operating Rent Roll</h4>
          <div className="grid grid-cols-2 gap-4">
            <SimpleMetric label="Occupied Units" value={`${property.occupiedUnits || 0} / ${property.totalUnits || property.units}`} />
            <SimpleMetric label="Occupancy" value={formatPercent(num(property.occupancyRate))} />
            <SimpleMetric label="Contracted Base Rent" value={`${formatExactCurrency(num(property.inPlaceRent))}/mo`} />
            <SimpleMetric label="Underwritten Rent" value={`${formatExactCurrency(num(property.proformaRent))}/mo`} highlight />
            <SimpleMetric label="Monthly Rent Upside" value={formatExactCurrency(num(property.rentUpside))} highlight />
          </div>
        </div>

        <div className="panel-summary p-5">
          <h4 className="text-sm uppercase tracking-[0.2em] text-muted-foreground mb-4">Underwriting Returns</h4>
          <div className="grid grid-cols-2 gap-4">
            <SimpleMetric label="Yield on Cost" value={formatPercent(num(property.yieldOnCost))} highlight />
            <SimpleMetric label="Debt Yield" value={formatPercent(num(property.debtYield))} />
            <SimpleMetric label="DSCR" value={`${num(property.dscrStabilized).toFixed(2)}x`} highlight={num(property.dscrStabilized) >= 1.25} />
            <SimpleMetric label={cashflowLabel} value={formatSignedCurrency(num(property.cashflow))} />
          </div>
        </div>

        <div className="panel-summary p-5">
          <h4 className="text-sm uppercase tracking-[0.2em] text-muted-foreground mb-4">Debt Position</h4>
          <div className="grid grid-cols-2 gap-4">
            <SimpleMetric label={debtLabel} value={formatExactCurrency(currentDebt)} />
            <SimpleMetric label="LTV" value={formatPercent(currentLTV)} />
            <SimpleMetric label={debtServiceLabel} value={formatExactCurrency(monthlyDebtService)} />
            <SimpleMetric label="Property Equity" value={formatExactCurrency(propertyEquity)} highlight />
          </div>
        </div>
      </div>

      {hasIncrementalLenderScenario && (
        <div className="p-5 bg-warm-brass/5 border border-warm-brass/20 rounded-lg">
          <h4 className="text-sm uppercase tracking-[0.2em] text-warm-brass mb-4">Modeled Lender Scenario</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SimpleMetric label="Loan Amount" value={formatExactCurrency(modeledLoan)} />
            <SimpleMetric label="LTV" value={formatPercent(num(property.refiLTV))} />
            <SimpleMetric label="Monthly P&I" value={formatExactCurrency(num(property.newMonthlyPI))} />
            <SimpleMetric label="Gross Cash-Out" value={formatExactCurrency(num(property.refiCashOut))} highlight />
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            This is the lender underwriting case and is not presented as funded cash.
          </p>
        </div>
      )}

      {property.id === "lucia-apartments" && (
        <p className="text-xs text-muted-foreground border-t border-border pt-4">
          Lucia loan and cash-flow figures are underwriting; funding is not presented as confirmed.
        </p>
      )}
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
          <DialogDescription className="sr-only">
            Property-level operating totals, underwriting metrics, and investment details for {property.name}.
          </DialogDescription>
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
                src={getPublicPropertyImage(property)}
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
