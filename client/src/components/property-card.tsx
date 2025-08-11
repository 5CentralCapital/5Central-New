import { type Property } from "@shared/schema";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface PropertyCardProps {
  property: Property;
  imageUrl: string;
}

export default function PropertyCard({ property, imageUrl }: PropertyCardProps) {
  const formatCurrency = (value: string | null) => {
    if (!value) return "N/A";
    const num = parseFloat(value);
    if (num >= 1000000) {
      return `$${(num / 1000000).toFixed(1)}M`;
    } else if (num >= 1000) {
      return `$${(num / 1000).toFixed(0)}K`;
    }
    return `$${num.toLocaleString()}`;
  };

  const formatIRR = (irr: string | null) => {
    if (!irr) return "N/A";
    const num = parseFloat(irr);
    return `${num > 0 ? '+' : ''}${num.toFixed(1)}%`;
  };

  const getIRRColor = (irr: string | null) => {
    if (!irr) return "bg-gray-100 text-gray-800";
    const num = parseFloat(irr);
    if (num > 0) return "bg-green-100 text-green-800";
    if (num < 0) return "bg-red-100 text-red-800";
    return "bg-gray-100 text-gray-800";
  };

  const acquisitionDate = new Date(property.acquisitionDate);
  const formattedDate = acquisitionDate.toLocaleDateString('en-US', { 
    month: 'short', 
    year: 'numeric' 
  });

  return (
    <Card 
      className="bg-white rounded-2xl card-shadow premium-border overflow-hidden hover:shadow-2xl transition-all duration-300 transform hover:-translate-y-2"
      data-testid={`property-card-${property.id}`}
    >
      <img 
        src={imageUrl} 
        alt={`${property.name} Property`} 
        className="w-full h-64 object-cover"
        data-testid={`property-image-${property.id}`}
      />
      <CardContent className="p-6">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className="text-xl font-serif font-semibold text-primary mb-1" data-testid={`property-name-${property.id}`}>
              {property.name}
            </h3>
            <p className="text-gray-600" data-testid={`property-location-${property.id}`}>
              {property.city}, {property.state} • {property.units} Units
            </p>
          </div>
          <div className="text-right">
            <div className="text-sm text-gray-500">Acquired {formattedDate}</div>
            <div className="text-sm text-accent-gold font-medium" data-testid={`property-years-held-${property.id}`}>
              {property.yearsHeld} years held
            </div>
          </div>
        </div>
        
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <div className="text-2xl font-bold text-primary" data-testid={`property-purchase-price-${property.id}`}>
              {formatCurrency(property.acquisitionPrice)}
            </div>
            <div className="text-sm text-gray-500">Purchase Price</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-accent-gold" data-testid={`property-current-value-${property.id}`}>
              {formatCurrency(property.currentValue || property.salePrice)}
            </div>
            <div className="text-sm text-gray-500">
              {property.status === 'sold' ? 'Sale Price' : 'Current Value'}
            </div>
          </div>
        </div>
        
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">
            Annual Cash Flow: 
            <span className="text-primary font-medium ml-1" data-testid={`property-cashflow-${property.id}`}>
              {formatCurrency(property.noi)}
            </span>
          </span>
          <Badge 
            className={`px-2 py-1 rounded font-medium ${getIRRColor(property.irr)}`}
            data-testid={`property-irr-${property.id}`}
          >
            {formatIRR(property.irr)} ROI
          </Badge>
        </div>

        {property.status === 'sold' && (
          <div className="mt-4 pt-4 border-t border-gray-200">
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">Equity Multiple:</span>
              <span className="text-lg font-bold text-accent-gold" data-testid={`property-equity-multiple-${property.id}`}>
                {property.equityMultiple}x
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
