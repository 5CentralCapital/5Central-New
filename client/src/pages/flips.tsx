import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Camera,
  CameraOff,
  Check,
  CircleDollarSign,
  FileSpreadsheet,
  Images,
  Info,
  MapPin,
  Maximize2,
  TrendingUp,
  WalletCards,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  currentFlips,
  flipPortfolioSummary,
  flipsSource,
  soldFlips,
  type FlipPhoto,
  type FlipPhotoStage,
  type FlipProject,
} from "@/lib/flips-data";

const wholeCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const exactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactCurrency = (value: number) => {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return wholeCurrency.format(value);
};

const percentage = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;

const stageLabels: Record<FlipPhotoStage, string> = {
  before: "Before",
  current: "Current",
  design: "Design",
  after: "After",
};

const stageOrder: FlipPhotoStage[] = ["before", "current", "design", "after"];

const defaultPhotoStage = (project: FlipProject): FlipPhotoStage => {
  if (project.photos.some((photo) => photo.stage === "current")) return "current";
  if (project.photos.some((photo) => photo.stage === "before")) return "before";
  if (project.photos.some((photo) => photo.stage === "design")) return "design";
  return "before";
};

function StatusBadge({ project }: { project: FlipProject }) {
  const isContract = project.status === "acquisition-under-contract";

  return (
    <span
      className={`inline-flex items-center gap-2 border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${
        isContract
          ? "border-warm-brass/40 bg-warm-brass/10 text-[#765f39]"
          : "border-emerald-700/20 bg-emerald-50 text-emerald-800"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${isContract ? "bg-warm-brass" : "bg-emerald-600"}`} />
      {project.statusLabel}
    </span>
  );
}

function ProgressBar({ project, compact = false }: { project: FlipProject; compact?: boolean }) {
  const progress = project.rehabForecast > 0 ? project.rehabLogged / project.rehabForecast : 0;
  const clampedProgress = Math.min(Math.max(progress, 0), 1);

  return (
    <div>
      <div className="mb-2 flex items-end justify-between gap-4">
        <div>
          <p className={`${compact ? "text-[9px]" : "text-[10px]"} font-semibold uppercase tracking-[0.18em] text-muted-foreground`}>
            Budget deployed
          </p>
          {!compact && (
            <p className="mt-1 text-sm text-foreground">
              {exactCurrency.format(project.rehabLogged)} logged of {exactCurrency.format(project.rehabForecast)}
            </p>
          )}
        </div>
        <span className={`${compact ? "text-sm" : "text-2xl"} font-serif text-foreground`}>
          {percentage(clampedProgress)}
        </span>
      </div>
      <div className={`${compact ? "h-1.5" : "h-2"} overflow-hidden bg-border/70`}>
        <div
          className="h-full bg-warm-brass transition-[width] duration-700"
          style={{ width: `${clampedProgress * 100}%` }}
        />
      </div>
      {!compact && (
        <div className="mt-2 flex justify-between text-xs text-muted-foreground">
          <span>{exactCurrency.format(project.rehabRemaining)} remaining</span>
          <span>Spend-based control</span>
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  selected,
  onSelect,
}: {
  project: FlipProject;
  selected: boolean;
  onSelect: () => void;
}) {
  const cover = project.photos.find((photo) => photo.stage === "current") ?? project.photos[0];
  const isConcept = cover?.stage === "design";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`group w-full overflow-hidden border bg-white text-left transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warm-brass focus-visible:ring-offset-2 ${
        selected
          ? "border-warm-brass shadow-[0_18px_55px_rgba(26,26,26,0.10)]"
          : "border-border hover:-translate-y-1 hover:border-warm-brass/50 hover:shadow-lg"
      }`}
      data-testid={`flip-card-${project.slug}`}
    >
      {cover ? (
        <div className="relative aspect-[16/9] overflow-hidden bg-soft-cream">
          <img
            src={cover.src}
            alt={cover.alt}
            className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
            loading="lazy"
          />
          <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/65 to-transparent" />
          <span className="absolute bottom-4 left-4 border border-white/30 bg-black/35 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-white backdrop-blur-sm">
            {isConcept ? "Concept image" : "Current progress"}
          </span>
        </div>
      ) : (
        <div className="flex aspect-[16/9] flex-col justify-between bg-deep-charcoal p-5 text-white">
          <FileSpreadsheet className="h-5 w-5 text-warm-brass" />
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-warm-brass">Acquisition file</p>
            <p className="mt-2 max-w-xs font-serif text-2xl leading-tight">Photo record begins at purchase close.</p>
          </div>
        </div>
      )}

      <div className="p-5">
        <div className="mb-5 flex min-h-12 items-start justify-between gap-3">
          <div>
            <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3 text-warm-brass" />
              {project.location}
            </p>
            <h3 className="text-2xl text-foreground">{project.name}</h3>
          </div>
          <ArrowUpRight className={`mt-1 h-5 w-5 transition-colors ${selected ? "text-warm-brass" : "text-muted-foreground group-hover:text-warm-brass"}`} />
        </div>

        <div className="mb-5">
          <StatusBadge project={project} />
        </div>

        <div className="mb-5 grid grid-cols-3 divide-x divide-border border-y border-border py-4">
          <div className="pr-3">
            <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Purchase</p>
            <p className="mt-1 font-serif text-lg">{compactCurrency(project.purchasePrice)}</p>
          </div>
          <div className="px-3">
            <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Exit</p>
            <p className="mt-1 font-serif text-lg">{compactCurrency(project.projectedSale)}</p>
          </div>
          <div className="pl-3">
            <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">ROI</p>
            <p className="mt-1 font-serif text-lg text-warm-stone">{percentage(project.roiOnModeledEquity)}</p>
          </div>
        </div>

        <ProgressBar project={project} compact />
      </div>
    </button>
  );
}

function PhotoGallery({ project }: { project: FlipProject }) {
  const [stage, setStage] = useState<FlipPhotoStage>(() => defaultPhotoStage(project));
  const [selectedPhoto, setSelectedPhoto] = useState<FlipPhoto | null>(null);
  const [lightboxPhoto, setLightboxPhoto] = useState<FlipPhoto | null>(null);
  const [thumbnailPage, setThumbnailPage] = useState(0);

  useEffect(() => {
    const nextStage = defaultPhotoStage(project);
    const nextPhoto = project.photos.find((photo) => photo.stage === nextStage) ?? null;
    setStage(nextStage);
    setSelectedPhoto(nextPhoto);
    setLightboxPhoto(null);
    setThumbnailPage(0);
  }, [project]);

  const visiblePhotos = useMemo(
    () => project.photos.filter((photo) => photo.stage === stage),
    [project.photos, stage],
  );

  useEffect(() => {
    setSelectedPhoto(visiblePhotos[0] ?? null);
    setThumbnailPage(0);
  }, [stage, visiblePhotos]);

  const thumbnailsPerPage = 10;
  const thumbnailPageCount = Math.ceil(visiblePhotos.length / thumbnailsPerPage);
  const thumbnailStart = thumbnailPage * thumbnailsPerPage;
  const visibleThumbnails = visiblePhotos.slice(thumbnailStart, thumbnailStart + thumbnailsPerPage);

  const selectThumbnailPage = (nextPage: number) => {
    const safePage = Math.max(0, Math.min(nextPage, thumbnailPageCount - 1));
    setThumbnailPage(safePage);
    setSelectedPhoto(visiblePhotos[safePage * thumbnailsPerPage] ?? null);
  };

  const emptyCopy = stage === "after"
    ? "After photos are added only when the renovation is complete and the finished condition is documented."
    : stage === "current"
      ? "No current construction photos are recorded for this project yet."
      : stage === "before"
        ? "No verified acquisition-condition photos are recorded for this project yet."
        : "No design concepts are recorded for this project yet.";

  return (
    <div className="border border-border bg-white" data-testid="flip-photo-gallery">
      <div className="flex flex-col gap-4 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Images className="h-4 w-4 text-warm-brass" />
          <div>
            <p className="text-sm font-semibold text-foreground">Project photos</p>
            <p className="text-xs text-muted-foreground">Evidence and concepts stay in separate lanes.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Photo stage">
          {stageOrder.map((photoStage) => {
            const count = project.photos.filter((photo) => photo.stage === photoStage).length;
            const isActive = stage === photoStage;
            return (
              <button
                key={photoStage}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setStage(photoStage)}
                className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] transition-colors ${
                  isActive
                    ? "bg-deep-charcoal text-white"
                    : "bg-soft-cream text-muted-foreground hover:text-foreground"
                }`}
              >
                {stageLabels[photoStage]} <span className={isActive ? "text-warm-brass" : "text-muted-foreground"}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {selectedPhoto ? (
        <div>
          <button
            type="button"
            onClick={() => setLightboxPhoto(selectedPhoto)}
            className="group relative block aspect-[16/9] w-full overflow-hidden bg-soft-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-warm-brass"
            aria-label="Open selected photo"
          >
            <img src={selectedPhoto.src} alt={selectedPhoto.alt} className="h-full w-full object-cover" />
            <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />
            <span className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center bg-white/90 text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
              <Maximize2 className="h-4 w-4" />
            </span>
            {selectedPhoto.stage === "design" && (
              <span className="absolute left-4 top-4 border border-white/40 bg-black/50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white backdrop-blur-sm">
                Concept only
              </span>
            )}
          </button>

          <div className="border-t border-border p-4 sm:p-5">
            <p className="text-sm text-muted-foreground">{selectedPhoto.caption}</p>
            {visiblePhotos.length > 1 && (
              <div className="mt-4">
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {visibleThumbnails.map((photo) => (
                    <button
                      key={photo.src}
                      type="button"
                      onClick={() => setSelectedPhoto(photo)}
                      className={`aspect-[4/3] overflow-hidden border-2 bg-soft-cream transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warm-brass ${
                        selectedPhoto.src === photo.src ? "border-warm-brass" : "border-transparent hover:border-border"
                      }`}
                      aria-label={`View ${photo.caption}`}
                    >
                      <img src={photo.src} alt="" className="h-full w-full object-cover" loading="lazy" />
                    </button>
                  ))}
                </div>

                {thumbnailPageCount > 1 && (
                  <div className="mt-3 flex items-center justify-between gap-4 border-t border-border pt-3">
                    <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      Photos {thumbnailStart + 1}–{Math.min(thumbnailStart + thumbnailsPerPage, visiblePhotos.length)} of {visiblePhotos.length}
                    </p>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => selectThumbnailPage(thumbnailPage - 1)}
                        disabled={thumbnailPage === 0}
                        className="flex h-9 w-9 items-center justify-center border border-border text-foreground transition-colors hover:border-warm-brass hover:text-warm-stone disabled:cursor-not-allowed disabled:opacity-35"
                        aria-label="Previous photo thumbnails"
                      >
                        <ArrowRight className="h-4 w-4 rotate-180" />
                      </button>
                      <button
                        type="button"
                        onClick={() => selectThumbnailPage(thumbnailPage + 1)}
                        disabled={thumbnailPage >= thumbnailPageCount - 1}
                        className="flex h-9 w-9 items-center justify-center border border-border text-foreground transition-colors hover:border-warm-brass hover:text-warm-stone disabled:cursor-not-allowed disabled:opacity-35"
                        aria-label="Next photo thumbnails"
                      >
                        <ArrowRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-80 flex-col items-center justify-center px-6 py-16 text-center">
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-soft-cream">
            <CameraOff className="h-5 w-5 text-warm-brass" />
          </div>
          <h3 className="text-2xl">Nothing mislabeled here.</h3>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{emptyCopy}</p>
        </div>
      )}

      <Dialog open={Boolean(lightboxPhoto)} onOpenChange={(open) => !open && setLightboxPhoto(null)}>
        <DialogContent className="max-h-[94vh] max-w-6xl overflow-hidden border-white/10 bg-[#111] p-0 text-white">
          <DialogTitle className="sr-only">{lightboxPhoto?.alt}</DialogTitle>
          <DialogDescription className="sr-only">Expanded project photo</DialogDescription>
          {lightboxPhoto && (
            <>
              <div className="flex max-h-[82vh] min-h-64 items-center justify-center bg-black">
                <img src={lightboxPhoto.src} alt={lightboxPhoto.alt} className="max-h-[82vh] w-full object-contain" />
              </div>
              <div className="border-t border-white/10 px-5 py-4 text-sm text-white/70">{lightboxPhoto.caption}</div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MetricRow({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/70 py-3 last:border-b-0">
      <dt className="text-xs leading-relaxed text-muted-foreground">{label}</dt>
      <dd className={`text-right text-sm font-medium tabular-nums ${accent ? "text-warm-stone" : "text-foreground"}`}>{value}</dd>
    </div>
  );
}

function DetailGroup({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border border-border bg-white p-5 md:p-6">
      <div className="mb-4 flex items-center gap-3 border-b border-border pb-4">
        <span className="flex h-8 w-8 items-center justify-center bg-soft-cream text-warm-brass">{icon}</span>
        <h3 className="text-xl">{title}</h3>
      </div>
      <dl>{children}</dl>
    </section>
  );
}

function ProjectTimeline({ project }: { project: FlipProject }) {
  return (
    <section className="border border-border bg-white p-5 md:p-7">
      <div className="mb-7 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-warm-brass">Workbook schedule</p>
          <h3 className="mt-1 text-2xl">Modeled project timeline</h3>
        </div>
        <p className="text-xs text-muted-foreground">Targets are projections, not completion evidence.</p>
      </div>

      <ol className="grid gap-0 md:grid-cols-5">
        {project.milestones.map((milestone, index) => {
          const isComplete = milestone.state === "complete";
          const isCurrent = milestone.state === "current";
          return (
            <li key={`${milestone.label}-${milestone.date}`} className="relative flex gap-4 pb-6 last:pb-0 md:block md:pb-0">
              {index < project.milestones.length - 1 && (
                <span className="absolute left-[13px] top-7 h-[calc(100%-1.1rem)] w-px bg-border md:left-7 md:right-0 md:top-[13px] md:h-px md:w-[calc(100%-1.75rem)]" />
              )}
              <span
                className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border md:mb-4 ${
                  isComplete
                    ? "border-deep-charcoal bg-deep-charcoal text-white"
                    : isCurrent
                      ? "border-warm-brass bg-warm-brass text-deep-charcoal shadow-[0_0_0_5px_rgba(196,165,116,0.14)]"
                      : "border-border bg-white text-muted-foreground"
                }`}
              >
                {isComplete ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
              </span>
              <div className="pt-0.5 md:pr-4 md:pt-0">
                <p className={`text-xs font-semibold ${isCurrent ? "text-warm-stone" : "text-foreground"}`}>{milestone.label}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{milestone.date}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ProjectDetail({ project }: { project: FlipProject }) {
  return (
    <div id="flip-details" className="scroll-mt-28">
      <div className="mb-8 flex flex-col gap-5 border-b border-border pb-8 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <StatusBadge project={project} />
          </div>
          <h2 className="text-4xl text-foreground md:text-5xl">{project.name}</h2>
          <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4 text-warm-brass" /> {project.location}
          </p>
        </div>
        <p className="max-w-xl text-base leading-relaxed text-muted-foreground">{project.thesis}</p>
      </div>

      <div className="mb-8 grid grid-cols-2 gap-px overflow-hidden border border-border bg-border lg:grid-cols-4">
        {[
          { label: "Projected sale", value: wholeCurrency.format(project.projectedSale) },
          { label: "Project profit", value: wholeCurrency.format(project.projectProfit) },
          { label: "ROI on modeled equity", value: percentage(project.roiOnModeledEquity) },
          { label: "Net sale cash", value: wholeCurrency.format(project.netSaleCashAfterDebt) },
        ].map((metric) => (
          <div key={metric.label} className="bg-white p-5 md:p-6">
            <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{metric.label}</p>
            <p className="mt-2 font-serif text-2xl text-foreground md:text-3xl">{metric.value}</p>
            <p className="mt-1 text-[10px] text-warm-stone">Modeled</p>
          </div>
        ))}
      </div>

      <div className="mb-8 grid gap-8 lg:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.75fr)]">
        <PhotoGallery project={project} />

        <aside className="space-y-5">
          <div className="border border-border bg-soft-cream p-5 md:p-6">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-warm-brass">Live project lane</p>
            <h3 className="mt-2 text-2xl">{project.statusLabel}</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{project.statusNote}</p>
            <div className="mt-6 border-t border-border pt-5">
              <ProgressBar project={project} />
            </div>
          </div>

          <div className="border border-border bg-deep-charcoal p-5 text-white md:p-6">
            <div className="flex items-center gap-3">
              <Info className="h-4 w-4 text-warm-brass" />
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-warm-brass">Model case</p>
            </div>
            <p className="mt-4 font-serif text-3xl">3.5% selling costs</p>
            <p className="mt-2 text-sm leading-relaxed text-white/60">
              The workbook compares this case with 7.5%. Modeled savings for this project are {exactCurrency.format(project.sellingCostSavings)}.
            </p>
          </div>
        </aside>
      </div>

      <div className="mb-8 grid gap-5 lg:grid-cols-3">
        <DetailGroup title="Project budget" icon={<BarChart3 className="h-4 w-4" />}>
          <MetricRow label="Purchase price" value={exactCurrency.format(project.purchasePrice)} />
          <MetricRow label="Acquisition charges" value={exactCurrency.format(project.acquisitionCharges)} />
          <MetricRow label="Acquisition credits" value={project.acquisitionCredits ? `(${exactCurrency.format(project.acquisitionCredits)})` : exactCurrency.format(0)} />
          <MetricRow label="Net acquisition costs" value={exactCurrency.format(project.netAcquisitionCosts)} />
          <MetricRow label="Rehab forecast" value={exactCurrency.format(project.rehabForecast)} />
          <MetricRow label="Rehab logged" value={exactCurrency.format(project.rehabLogged)} />
          <MetricRow label="Rehab remaining" value={exactCurrency.format(project.rehabRemaining)} />
          <MetricRow label="Carry, interest, tax & operations" value={exactCurrency.format(project.carryAndInterest)} />
          <MetricRow label="Exit fee" value={exactCurrency.format(project.exitFee)} />
          <MetricRow label="Selling costs @ 3.5%" value={exactCurrency.format(project.sellingCosts)} />
          <MetricRow label="Selling costs @ 7.5%" value={exactCurrency.format(project.priorSellingCosts)} />
          <MetricRow label="Modeled selling-cost savings" value={exactCurrency.format(project.sellingCostSavings)} accent />
        </DetailGroup>

        <DetailGroup title="Capital plan" icon={<WalletCards className="h-4 w-4" />}>
          <MetricRow label="Project loan / payoff" value={exactCurrency.format(project.projectLoanOrPayoff)} />
          <MetricRow label="Cash through purchase close" value={exactCurrency.format(project.cashThroughClose)} />
          <MetricRow label="Rehab loan / draws" value={exactCurrency.format(project.rehabLoanOrDraws)} />
          <MetricRow label="Net rehab cash" value={exactCurrency.format(project.netRehabCash)} />
          <MetricRow label="Total modeled equity capital" value={exactCurrency.format(project.modeledEquityCapital)} accent />
        </DetailGroup>

        <DetailGroup title="Projected returns" icon={<TrendingUp className="h-4 w-4" />}>
          <MetricRow label="Projected sale" value={exactCurrency.format(project.projectedSale)} />
          <MetricRow label="Net sale cash after debt" value={exactCurrency.format(project.netSaleCashAfterDebt)} />
          <MetricRow label="Project profit @ 3.5%" value={exactCurrency.format(project.projectProfit)} accent />
          <MetricRow label="Project profit @ 7.5%" value={exactCurrency.format(project.projectProfitPriorCase)} />
          <MetricRow label="ROI on modeled equity" value={percentage(project.roiOnModeledEquity, 2)} accent />
          <MetricRow label="Profit margin on projected sale" value={percentage(project.projectProfit / project.projectedSale, 2)} />
          <MetricRow label="Selling-cost case improvement" value={exactCurrency.format(project.sellingCostSavings)} />
        </DetailGroup>
      </div>

      <ProjectTimeline project={project} />
    </div>
  );
}

function SoldEmptyState() {
  return (
    <div className="border border-border bg-white px-6 py-16 text-center md:py-24">
      <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-soft-cream">
        <Camera className="h-6 w-6 text-warm-brass" />
      </div>
      <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-warm-brass">Realized archive</p>
      <h2 className="mt-3 text-3xl md:text-4xl">No current project is sold yet.</h2>
      <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
        Completed flips will move here only after closing, with realized figures and verified before-and-after photos replacing the modeled case.
      </p>
    </div>
  );
}

export default function Flips() {
  const [view, setView] = useState<"active" | "sold">("active");
  const [selectedSlug, setSelectedSlug] = useState(currentFlips[0].slug);

  const selectedProject = currentFlips.find((project) => project.slug === selectedSlug) ?? currentFlips[0];
  const projects = view === "active" ? currentFlips : soldFlips;

  const selectProject = (slug: string) => {
    setSelectedSlug(slug);
    window.setTimeout(() => {
      document.getElementById("flip-details")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  };

  return (
    <main className="min-h-screen bg-background" data-testid="flips-page">
      <section className="relative overflow-hidden border-b border-border bg-soft-cream pb-16 pt-32 md:pb-20 md:pt-40">
        <div className="absolute inset-x-0 top-20 h-px bg-gradient-to-r from-transparent via-warm-brass/50 to-transparent" />
        <div className="container-wide relative">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(380px,0.85fr)] lg:items-end">
            <div>
              <div className="mb-6 flex items-center gap-3">
                <span className="h-px w-10 bg-warm-brass" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.26em] text-warm-stone">Small project track record</span>
              </div>
              <h1 className="max-w-4xl text-foreground">
                Smaller flips. <span className="italic text-warm-brass">Full visibility.</span>
              </h1>
              <p className="mt-6 max-w-2xl text-lg font-light leading-relaxed text-muted-foreground md:text-xl">
                Follow every project from acquisition through rehab and resale—with progress photos, capital controls, and return metrics tied to one unified model.
              </p>
            </div>

            <div className="border border-border bg-white p-6 shadow-sm md:p-7">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-warm-brass">Current pipeline</p>
                  <p className="mt-1 text-sm text-muted-foreground">Status as of {flipsSource.statusAsOf}</p>
                </div>
                <CircleDollarSign className="h-6 w-6 text-warm-brass" />
              </div>
              <div className="space-y-0 border-y border-border">
                {currentFlips.map((project) => (
                  <button
                    key={project.slug}
                    type="button"
                    onClick={() => selectProject(project.slug)}
                    className="group flex w-full items-center justify-between gap-4 border-b border-border py-4 text-left last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warm-brass"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground group-hover:text-warm-stone">{project.name}</p>
                      <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{project.statusLabel}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-serif text-lg text-foreground">{compactCurrency(project.projectedSale)}</p>
                      <p className="text-[10px] text-muted-foreground">projected exit</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-border bg-deep-charcoal py-8 text-white md:py-10">
        <div className="container-wide grid grid-cols-2 gap-px overflow-hidden border border-white/10 bg-white/10 lg:grid-cols-4">
          {[
            { label: "Current projects", value: "3", note: "2 rehab · 1 acquisition" },
            { label: "Projected exits", value: compactCurrency(flipPortfolioSummary.projectedSaleValue), note: "Unified workbook" },
            { label: "Project profit", value: compactCurrency(flipPortfolioSummary.projectedProjectProfit), note: "3.5% selling-cost case" },
            { label: "Modeled equity", value: compactCurrency(flipPortfolioSummary.modeledEquityCapital), note: "Total across all projects" },
          ].map((metric) => (
            <div key={metric.label} className="bg-deep-charcoal p-5 md:p-7">
              <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-white/45">{metric.label}</p>
              <p className="mt-2 font-serif text-3xl text-white md:text-4xl">{metric.value}</p>
              <p className="mt-1 text-[10px] text-warm-brass">{metric.note}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="py-14 md:py-20">
        <div className="container-wide">
          <div className="mb-9 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-warm-brass">Project ledger</p>
              <h2 className="mt-2 text-4xl md:text-5xl">Follow the work. Audit the return.</h2>
            </div>
            <div className="inline-flex self-start border border-border bg-white p-1" role="tablist" aria-label="Flip project status">
              <button
                type="button"
                role="tab"
                aria-selected={view === "active"}
                onClick={() => setView("active")}
                className={`px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.16em] transition-colors ${view === "active" ? "bg-deep-charcoal text-white" : "text-muted-foreground hover:text-foreground"}`}
              >
                Current <span className="ml-1 text-warm-brass">{currentFlips.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "sold"}
                onClick={() => setView("sold")}
                className={`px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.16em] transition-colors ${view === "sold" ? "bg-deep-charcoal text-white" : "text-muted-foreground hover:text-foreground"}`}
              >
                Sold <span className="ml-1 text-warm-brass">{soldFlips.length}</span>
              </button>
            </div>
          </div>

          {view === "sold" ? (
            <SoldEmptyState />
          ) : (
            <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {projects.map((project) => (
                <ProjectCard
                  key={project.slug}
                  project={project}
                  selected={selectedProject.slug === project.slug}
                  onSelect={() => selectProject(project.slug)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {view === "active" && (
        <section className="border-y border-border bg-[#f7f6f2] py-14 md:py-20">
          <div className="container-wide">
            <ProjectDetail project={selectedProject} />
          </div>
        </section>
      )}

      <section className="bg-background py-14 md:py-20">
        <div className="container-wide">
          <div className="grid gap-8 border border-border bg-white p-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:p-9">
            <div className="flex gap-4">
              <FileSpreadsheet className="mt-1 h-5 w-5 shrink-0 text-warm-brass" />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-warm-brass">Source and state</p>
                <h2 className="mt-2 text-3xl">One model. Separate evidence lanes.</h2>
                <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  All financial figures come from {flipsSource.workbook}, saved {flipsSource.workbookSavedAt}. Current-stage labels are as of {flipsSource.statusAsOf}. Projections do not become realized results until a closing and final settlement evidence are recorded.
                </p>
              </div>
            </div>
            <Link href="/portfolio" className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-foreground hover:text-warm-stone">
              Main portfolio <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 bg-deep-charcoal py-8 text-white">
        <div className="container-wide flex flex-col gap-4 text-xs text-white/55 sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 5Central Capital. Tampa, Florida.</p>
          <div className="flex items-center gap-2 text-white/70">
            <CalendarDays className="h-3.5 w-3.5 text-warm-brass" />
            Financial model refreshed {flipsSource.workbookSavedAt}
          </div>
        </div>
      </footer>
    </main>
  );
}
