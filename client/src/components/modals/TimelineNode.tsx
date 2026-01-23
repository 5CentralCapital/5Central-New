import { cn } from "@/lib/utils";

interface TimelineMetric {
  label: string;
  value: string | number;
  highlight?: boolean;
}

interface TimelineNodeProps {
  type: "acquired" | "held" | "sold";
  title: string;
  subtitle?: string;
  metrics: TimelineMetric[];
  isLast?: boolean;
}

export function TimelineNode({
  type,
  title,
  subtitle,
  metrics,
  isLast = false,
}: TimelineNodeProps) {
  const typeLabels = {
    acquired: "Acquired",
    held: "Held",
    sold: "Sold",
  };

  return (
    <div className="relative flex gap-4">
      {/* Timeline connector */}
      <div className="flex flex-col items-center">
        {/* Node */}
        <div
          className={cn(
            "w-4 h-4 rounded-full flex-shrink-0 z-10",
            type === "sold" ? "bg-warm-brass" : "bg-warm-brass/60"
          )}
        />
        {/* Connecting line */}
        {!isLast && (
          <div className="w-px flex-1 bg-warm-brass/30 min-h-[60px]" />
        )}
      </div>

      {/* Content */}
      <div className={cn("pb-6 flex-1", isLast && "pb-0")}>
        <div className="flex items-baseline gap-2 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
            {typeLabels[type]}
          </span>
          <span className="text-xs text-muted-foreground">{title}</span>
        </div>
        {subtitle && (
          <p className="text-xs text-muted-foreground mb-2">{subtitle}</p>
        )}
        <div
          className={cn(
            "p-3 rounded-lg grid gap-x-4 gap-y-2",
            type === "sold" ? "bg-warm-brass/5 border border-warm-brass/20" : "bg-muted/30"
          )}
          style={{ gridTemplateColumns: `repeat(${Math.min(metrics.length, 3)}, 1fr)` }}
        >
          {metrics.map((metric, index) => (
            <div key={index}>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {metric.label}
              </div>
              <div
                className={cn(
                  "text-sm font-medium",
                  metric.highlight ? "text-warm-brass" : "text-foreground"
                )}
              >
                {metric.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface InvestmentTimelineProps {
  children: React.ReactNode;
  className?: string;
}

export function InvestmentTimeline({ children, className }: InvestmentTimelineProps) {
  return <div className={cn("space-y-0", className)}>{children}</div>;
}
