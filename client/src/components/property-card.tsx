import { type Property } from "@shared/schema";
import { MapPin, Calendar } from "lucide-react";
import { getPublicPropertyMeta } from "@/lib/public-portfolio-data";

interface PropertyCardProps {
  property: Property;
  imageUrl: string;
  onClick?: () => void;
}

export default function PropertyCard({ property, imageUrl, onClick }: PropertyCardProps) {
  const meta = getPublicPropertyMeta(property);
  const isFlip = meta?.assetClass === "single_family_flip";

  const formatCurrency = (value: string | null) => {
    if (!value) return "—";
    const num = parseFloat(value);
    if (num >= 1000000) {
      return `$${(num / 1000000).toFixed(2)}M`;
    } else if (num >= 1000) {
      return `$${(num / 1000).toFixed(0)}K`;
    }
    return `$${num.toLocaleString()}`;
  };

  const formatIRR = (irr: string | null) => {
    if (!irr) return "—";
    const num = parseFloat(irr);
    return `${num > 0 ? '+' : ''}${num.toFixed(1)}%`;
  };

  const calculateIRRFromTotalProfit = (property: Property) => {
    const initialInvestment = parseFloat(property.acquisitionPrice) + parseFloat(property.rehabCosts || '0');
    const totalCashCollected = parseFloat(property.totalCashflow || '0');
    const exitValue = parseFloat(property.salePrice || property.currentValue || '0');
    const yearsHeld = parseFloat(property.yearsHeld || '0');

    if (initialInvestment && exitValue && yearsHeld > 0) {
      const totalProfit = exitValue + totalCashCollected - initialInvestment;
      const totalReturn = initialInvestment + totalProfit;
      const irr = Math.pow(totalReturn / initialInvestment, 1 / yearsHeld) - 1;
      return (irr * 100).toFixed(1);
    }
    return property.irr || '0';
  };

  // Parse date as UTC to avoid timezone shift issues
  const acquisitionDate = new Date(property.acquisitionDate);
  const formattedDate = acquisitionDate.toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  });

  // Calculate actual years held
  const endDate = property.saleDate ? new Date(property.saleDate) : new Date();
  const yearsHeldActual = ((endDate.getTime() - acquisitionDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25)).toFixed(1);
  const holdPeriodLabel = isFlip
    ? `${property.holdPeriodMonths || 7} month base hold`
    : `${yearsHeldActual} years held`;

  return (
    <div
      className="group card-refined overflow-hidden cursor-pointer hover:shadow-lg transition-shadow duration-300"
      data-testid={`property-card-${property.id}`}
      onClick={onClick}
    >
      {/* Image Container */}
      <div className="property-image-wrapper aspect-[4/3] bg-muted">
        <img
          src={imageUrl}
          alt={`${property.name} Property`}
          className="w-full h-full object-cover"
          data-testid={`property-image-${property.id}`}
        />
      </div>

      {/* Content */}
      <div className="p-6">
        {/* Header */}
        <div className="mb-6">
          <h3
            className="text-xl font-serif font-medium text-foreground mb-2 group-hover:text-warm-brass transition-colors duration-300"
            data-testid={`property-name-${property.id}`}
          >
            {property.name}
          </h3>
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5" data-testid={`property-location-${property.id}`}>
              <MapPin className="w-3.5 h-3.5" />
              {property.city}, {property.state}
            </span>
            <span className="text-border">•</span>
            <span>{isFlip ? "Single-family flip" : `${property.units} Units`}</span>
          </div>
        </div>

        {/* Acquisition Info */}
        <div className="flex items-center justify-between text-sm mb-6 pb-6 border-b border-border">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Calendar className="w-3.5 h-3.5" />
            <span>{isFlip ? "Started" : "Acquired"} {formattedDate}</span>
          </div>
          <span className="text-warm-brass font-medium" data-testid={`property-years-held-${property.id}`}>
            {holdPeriodLabel}
          </span>
        </div>

        {/* Financial Grid */}
        {isFlip ? (
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Payoff</div>
              <div className="text-lg font-medium text-foreground" data-testid={`property-purchase-price-${property.id}`}>
                {formatCurrency(property.acquisitionPrice)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Target Sale</div>
              <div className="text-lg font-medium text-warm-brass" data-testid={`property-current-value-${property.id}`}>
                {formatCurrency(property.projectedSalePrice || property.currentValue)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Cash To Close</div>
              <div className="text-lg font-medium text-foreground" data-testid={`property-cashflow-${property.id}`}>
                {formatCurrency(property.projectedNetProceeds)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Project Profit</div>
              <div className="text-lg font-medium text-foreground" data-testid={`property-profit-${property.id}`}>
                {formatCurrency(property.totalProfit)}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Purchase</div>
              <div className="text-lg font-medium text-foreground" data-testid={`property-purchase-price-${property.id}`}>
                {formatCurrency(property.acquisitionPrice)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                {property.status === 'sold' ? 'Sale Price' : 'Current Value'}
              </div>
              <div className="text-lg font-medium text-warm-brass" data-testid={`property-current-value-${property.id}`}>
                {formatCurrency(property.currentValue || property.salePrice)}
              </div>
            </div>
            {property.status === 'current' ? (
            <>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">CapEx</div>
                <div className="text-lg font-medium text-foreground" data-testid={`property-rehab-${property.id}`}>
                  {formatCurrency(property.rehabCosts)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">NOI</div>
                <div className="text-lg font-medium text-foreground" data-testid={`property-cashflow-${property.id}`}>
                  {formatCurrency(property.noi)}
                </div>
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Total Cashflow</div>
                <div className="text-lg font-medium text-foreground" data-testid={`property-total-cashflow-${property.id}`}>
                  {formatCurrency(property.totalCashflow)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Total Profit</div>
                <div className="text-lg font-medium text-foreground" data-testid={`property-profit-${property.id}`}>
                  {(() => {
                    const buyPrice = parseFloat(property.acquisitionPrice);
                    const sellPrice = parseFloat(property.salePrice || '0');
                    const cashflow = parseFloat(property.totalCashflow || '0');
                    const rehab = parseFloat(property.rehabCosts || '0');
                    const profit = sellPrice - buyPrice - rehab + cashflow;
                    return formatCurrency(profit.toString());
                  })()}
                </div>
              </div>
            </>
            )}
          </div>
        )}

        {/* Performance Metrics */}
        <div className="pt-6 border-t border-border">
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center">
              <div className="text-xl font-serif font-medium text-warm-brass" data-testid={`property-irr-${property.id}`}>
                {isFlip ? `${parseFloat(property.cashOnCash || "0").toFixed(1)}%` : formatIRR(calculateIRRFromTotalProfit(property))}
              </div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mt-1">{isFlip ? "ROI" : "IRR"}</div>
            </div>
            <div className="text-center border-x border-border">
              <div className="text-xl font-serif font-medium text-warm-brass" data-testid={`property-equity-multiple-${property.id}`}>
                {property.equityMultiple || '—'}x
              </div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mt-1">Multiple</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-serif font-medium text-warm-brass" data-testid={`property-coc-${property.id}`}>
                {isFlip ? (
                  `${property.holdPeriodMonths || 7} mo`
                ) : (() => {
                  const initialInvestment = parseFloat(property.acquisitionPrice) + parseFloat(property.rehabCosts || '0');
                  const totalCashCollected = parseFloat(property.totalCashflow || '0');
                  const exitValue = parseFloat(property.salePrice || property.currentValue || '0');
                  const yearsHeld = parseFloat(property.yearsHeld || '0');

                  if (initialInvestment && exitValue && yearsHeld > 0) {
                    const totalProfit = exitValue + totalCashCollected - initialInvestment;
                    const annualizedCOC = (totalProfit / initialInvestment / yearsHeld) * 100;
                    return `${annualizedCOC.toFixed(1)}%`;
                  }
                  return '—';
                })()}
              </div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mt-1">{isFlip ? "Hold" : "COC"}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
