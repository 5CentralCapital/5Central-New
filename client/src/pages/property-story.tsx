import { Link, useRoute } from "wouter";
import { ArrowLeft, Camera, FileText, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getPublicPropertyImage,
  getPublicPropertyMeta,
  publicAllProperties,
} from "@/lib/public-portfolio-data";
import { type Property } from "@shared/schema";

const num = (value: string | number | null | undefined) =>
  typeof value === "number" ? value : parseFloat(value || "0") || 0;

const formatCurrency = (value: number) => {
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

const parsePhotos = (photosJson: string | null | undefined): string[] => {
  if (!photosJson) return [];
  try {
    return JSON.parse(photosJson);
  } catch {
    return [];
  }
};

function metricsFor(property: Property) {
  const meta = getPublicPropertyMeta(property);
  if (meta?.assetClass === "single_family_flip") {
    return [
      { label: "Target Sale", value: formatCurrency(num(property.projectedSalePrice) || num(property.currentValue)) },
      { label: "Cash To 5Central", value: formatCurrency(num(property.projectedNetProceeds)) },
      { label: "Full Project Profit", value: formatCurrency(num(property.totalProfit)) },
      { label: "Base Hold", value: `${property.holdPeriodMonths || 7} mo` },
    ];
  }

  if (property.status === "sold") {
    return [
      { label: "Sale Price", value: formatCurrency(num(property.salePrice)) },
      { label: "Total Profit", value: formatCurrency(num(property.totalProfit)) },
      { label: "Multiple", value: `${num(property.equityMultiple).toFixed(2)}x` },
      { label: "Units", value: property.units.toString() },
    ];
  }

  return [
    {
      label: property.id === "mlk-apartments" ? "Appraised Value" : "Underwritten Value",
      value: formatExactCurrency(num(property.currentValue)),
    },
    { label: "Underwritten NOI", value: formatExactCurrency(num(property.stabilizedNOI) || num(property.noi)) },
    { label: "Cap Rate", value: `${(num(property.exitCapRate) * 100).toFixed(1)}%` },
    { label: "Occupancy", value: `${(num(property.occupancyRate) * 100).toFixed(1)}%` },
  ];
}

export default function PropertyStory() {
  const [, params] = useRoute<{ slug: string }>("/portfolio/:slug");
  const slug = params?.slug || "";
  const property = publicAllProperties.find((item) => {
    const meta = getPublicPropertyMeta(item);
    return meta?.slug === slug || item.id === slug;
  });

  if (!property) {
    return (
      <div className="min-h-screen pt-32 bg-background">
        <div className="container-wide">
          <Link href="/portfolio" className="text-warm-brass hover:underline">
            Back to portfolio
          </Link>
          <h1 className="mt-6 text-foreground">Asset not found</h1>
        </div>
      </div>
    );
  }

  const meta = getPublicPropertyMeta(property);
  const beforePhotos = parsePhotos(property.beforePhotos);
  const afterPhotos = parsePhotos(property.afterPhotos);
  const gallery = [getPublicPropertyImage(property), ...afterPhotos, ...beforePhotos]
    .filter(Boolean)
    .filter((photo, index, list) => list.indexOf(photo) === index)
    .slice(0, 16);
  const assetLabel = meta?.assetClass === "single_family_flip"
    ? "Single-family flip"
    : property.status === "sold"
      ? "Realized exit"
      : `${property.units} unit multifamily`;

  return (
    <div className="min-h-screen bg-background pt-24" data-testid="property-story-page">
      <section className="pb-12 border-b border-border">
        <div className="container-wide">
          <Link href="/portfolio">
            <Button className="btn-outline mb-8">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Portfolio
            </Button>
          </Link>

          <div className="grid lg:grid-cols-5 gap-8 lg:gap-12 items-end">
            <div className="lg:col-span-3">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-px bg-warm-brass" />
                <span className="text-xs uppercase tracking-[0.2em] text-warm-brass font-medium">{assetLabel}</span>
              </div>
              <h1 className="text-foreground mb-4">{property.name}</h1>
              <p className="flex items-center gap-2 text-muted-foreground mb-6">
                <MapPin className="w-4 h-4 text-warm-brass" />
                {property.address}, {property.city}, {property.state}
              </p>
              <p className="text-lg text-muted-foreground max-w-2xl leading-relaxed">
                {property.investmentThesis || meta?.shortThesis || "Portfolio asset with verified performance metrics."}
              </p>
            </div>

            <div className="lg:col-span-2 grid grid-cols-2 gap-4">
              {metricsFor(property).map((metric) => (
                <div key={metric.label} className="border border-border bg-soft-cream p-4">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-2">{metric.label}</div>
                  <div className="font-serif text-2xl text-warm-brass">{metric.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="py-12">
        <div className="container-wide">
          <div className="grid lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2">
              <div className="aspect-[16/9] bg-muted overflow-hidden mb-4">
                <img src={getPublicPropertyImage(property)} alt={property.name} className="w-full h-full object-cover" />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {gallery.slice(1).map((photo) => (
                  <div key={photo} className="aspect-square bg-muted overflow-hidden">
                    <img src={photo} alt={`${property.name} gallery`} className="w-full h-full object-cover" />
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-5">
              <div className="panel-summary p-5">
                <div className="flex items-center gap-3 mb-4">
                  <Camera className="w-4 h-4 text-warm-brass" />
                  <h2 className="text-xl font-serif text-foreground">Photo Inventory</h2>
                </div>
                <p className="text-sm text-muted-foreground">
                  {meta?.photoCount || gallery.length} public photos are indexed for this asset. More can be added through the photo manifest generator.
                </p>
              </div>

              <div className="panel-summary p-5">
                <div className="flex items-center gap-3 mb-4">
                  <FileText className="w-4 h-4 text-warm-brass" />
                  <h2 className="text-xl font-serif text-foreground">Source</h2>
                </div>
                <p className="text-sm text-muted-foreground">
                  {meta?.sourceNote || "Historical exit record and public property data."}
                </p>
              </div>

              <Link href="/investor">
                <Button className="btn-accent w-full">Join Investor List</Button>
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
