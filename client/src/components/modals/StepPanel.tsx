import { cn } from "@/lib/utils";
import { type LucideIcon } from "lucide-react";

interface StepPanelProps {
  stepNumber: number;
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  children: React.ReactNode;
  className?: string;
  highlight?: boolean;
}

export function StepPanel({
  stepNumber,
  title,
  subtitle,
  icon: Icon,
  children,
  className,
  highlight = false,
}: StepPanelProps) {
  return (
    <div
      className={cn(
        "p-4 rounded-lg border transition-all duration-300 h-full",
        highlight
          ? "border-warm-brass/40 bg-warm-brass/5"
          : "border-border bg-card hover:border-warm-brass/20",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border/50">
        <div className="w-6 h-6 rounded flex items-center justify-center bg-warm-brass/10 text-warm-brass">
          <Icon className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider truncate">
            {title}
          </h4>
          {subtitle && (
            <p className="text-[10px] text-muted-foreground truncate">{subtitle}</p>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="space-y-2">{children}</div>
    </div>
  );
}
