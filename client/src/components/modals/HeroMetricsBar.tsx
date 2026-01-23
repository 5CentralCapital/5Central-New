import { cn } from "@/lib/utils";

interface HeroMetric {
  label: string;
  value: string | number;
  highlight?: boolean;
}

interface HeroMetricsBarProps {
  metrics: HeroMetric[];
  className?: string;
}

export function HeroMetricsBar({ metrics, className }: HeroMetricsBarProps) {
  return (
    <div
      className={cn(
        "grid gap-4 p-4 bg-warm-brass/5 border border-warm-brass/20 rounded-lg mb-6",
        `grid-cols-${metrics.length}`,
        className
      )}
      style={{ gridTemplateColumns: `repeat(${metrics.length}, 1fr)` }}
    >
      {metrics.map((metric, index) => (
        <div key={index} className="text-center">
          <div
            className={cn(
              "text-2xl font-serif font-semibold",
              metric.highlight ? "text-warm-brass" : "text-foreground"
            )}
          >
            {metric.value}
          </div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mt-1">
            {metric.label}
          </div>
        </div>
      ))}
    </div>
  );
}
