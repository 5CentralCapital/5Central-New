import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface MetricRowProps {
  label: string;
  beforeValue: string;
  afterValue: string;
  change?: string;
  changeType?: "positive" | "negative" | "neutral";
}

export function MetricRow({
  label,
  beforeValue,
  afterValue,
  change,
  changeType = "positive",
}: MetricRowProps) {
  return (
    <div className="py-1.5 border-b border-border/30 last:border-0">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
        {label}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-muted-foreground">{beforeValue}</span>
        <ArrowRight className="w-3 h-3 text-warm-brass flex-shrink-0" />
        <span className="text-xs font-medium text-foreground">{afterValue}</span>
        {change && (
          <span
            className={cn(
              "text-[10px] px-1 py-0.5 rounded font-medium",
              changeType === "positive" && "bg-warm-brass/10 text-warm-brass",
              changeType === "negative" && "bg-destructive/10 text-destructive",
              changeType === "neutral" && "bg-muted text-muted-foreground"
            )}
          >
            {change}
          </span>
        )}
      </div>
    </div>
  );
}

interface SimpleMetricProps {
  label: string;
  value: string | number;
  highlight?: boolean;
  size?: "sm" | "md";
}

export function SimpleMetric({ label, value, highlight = false, size = "sm" }: SimpleMetricProps) {
  return (
    <div className="py-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
        {label}
      </div>
      <div
        className={cn(
          "font-medium",
          size === "sm" ? "text-xs" : "text-sm",
          highlight ? "text-warm-brass" : "text-foreground"
        )}
      >
        {value}
      </div>
    </div>
  );
}
