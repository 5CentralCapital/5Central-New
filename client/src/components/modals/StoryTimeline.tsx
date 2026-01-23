import { cn } from "@/lib/utils";

interface StoryTimelineStep {
  number: number;
  title: string;
  subtitle?: string;
}

interface StoryTimelineProps {
  steps: StoryTimelineStep[];
  className?: string;
}

export function StoryTimeline({ steps, className }: StoryTimelineProps) {
  return (
    <div className={cn("relative flex items-center justify-between mb-8", className)}>
      {/* Connecting line */}
      <div className="absolute top-4 left-8 right-8 h-px bg-warm-brass/30 z-0" />

      {steps.map((step, index) => (
        <div key={step.number} className="relative z-10 flex flex-col items-center flex-1">
          {/* Node */}
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold bg-warm-brass text-deep-charcoal shadow-sm">
            {step.number}
          </div>
          {/* Label */}
          <span className="mt-2 text-xs uppercase tracking-wider text-foreground font-medium">
            {step.title}
          </span>
          {step.subtitle && (
            <span className="text-[10px] text-muted-foreground">
              {step.subtitle}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
