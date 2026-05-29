import { FileText, FolderOpen, Lock, TrendingUp } from "lucide-react";
import {
  dataRoomSections,
  publicCurrentProperties,
  publicPortfolioFacts,
  publicPortfolioPulse,
} from "@/lib/public-portfolio-data";

export default function DataRoom() {
  return (
    <div className="min-h-screen bg-background pt-24" data-testid="data-room-page">
      <section className="pb-12 border-b border-border">
        <div className="container-wide">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-px bg-warm-brass" />
            <span className="text-xs uppercase tracking-[0.2em] text-warm-brass font-medium">Private Data Room</span>
          </div>
          <div className="grid lg:grid-cols-2 gap-10 items-end">
            <div>
              <h1 className="text-foreground mb-5">Investor Source Files</h1>
              <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl">
                One private place for rent rolls, rehab proof, lender packages, source workbook extracts, and portfolio pulse reporting.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="panel-summary p-5">
                <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-2">Public AUM</div>
                <div className="font-serif text-3xl text-warm-brass">{publicPortfolioFacts.publicAumLabel}</div>
              </div>
              <div className="panel-summary p-5">
                <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-2">Units</div>
                <div className="font-serif text-3xl text-warm-brass">{publicPortfolioFacts.activeMultifamilyUnits}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-12">
        <div className="container-wide">
          <div className="grid lg:grid-cols-3 gap-6 mb-10">
            {dataRoomSections.map((section) => (
              <div key={section.title} className="card-refined p-6">
                <FolderOpen className="w-5 h-5 text-warm-brass mb-5" />
                <h2 className="text-xl font-serif text-foreground mb-4">{section.title}</h2>
                <div className="space-y-3">
                  {section.items.map((item) => (
                    <div key={item} className="flex items-center justify-between border-b border-border pb-3">
                      <span className="text-sm text-muted-foreground">{item}</span>
                      <Lock className="w-3.5 h-3.5 text-warm-brass" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <div className="panel-summary p-6">
              <div className="flex items-center gap-3 mb-5">
                <TrendingUp className="w-5 h-5 text-warm-brass" />
                <h2 className="text-xl font-serif text-foreground">Weekly Portfolio Pulse</h2>
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                {publicPortfolioPulse.cards.map((card) => (
                  <div key={card.label} className="bg-background border border-border p-4">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-2">{card.label}</div>
                    <div className="font-serif text-2xl text-warm-brass">{card.value}</div>
                    <p className="text-xs text-muted-foreground mt-1">{card.sublabel}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel-summary p-6">
              <div className="flex items-center gap-3 mb-5">
                <FileText className="w-5 h-5 text-warm-brass" />
                <h2 className="text-xl font-serif text-foreground">Asset Files</h2>
              </div>
              <div className="space-y-3">
                {publicCurrentProperties.map((property) => (
                  <div key={property.id} className="flex items-center justify-between border-b border-border pb-3">
                    <div>
                      <div className="font-medium text-foreground">{property.name}</div>
                      <div className="text-xs text-muted-foreground">{property.city}, {property.state}</div>
                    </div>
                    <span className="text-xs uppercase tracking-wider text-warm-brass">Queued</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
