import { cn } from "@/lib/utils";

interface HighlightMetricProps {
  label: string;
  value: string | number;
  size?: "sm" | "md" | "lg";
  variant?: "default" | "featured";
}

export function HighlightMetric({
  label,
  value,
  size = "md",
  variant = "default",
}: HighlightMetricProps) {
  return (
    <div
      className={cn(
        "text-center p-3 rounded-lg",
        variant === "featured"
          ? "bg-warm-brass/10 border border-warm-brass/20"
          : "bg-muted/50"
      )}
    >
      <div
        className={cn(
          "font-semibold",
          size === "sm" && "text-lg",
          size === "md" && "text-xl",
          size === "lg" && "text-2xl",
          variant === "featured" ? "text-warm-brass" : "text-foreground"
        )}
      >
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-1">
        {label}
      </div>
    </div>
  );
}
