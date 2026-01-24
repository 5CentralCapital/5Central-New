import { cn } from "@/lib/utils";

interface StoryTimelineStep {
  number: number;
  title: string;
  subtitle?: string;
}

interface StoryTimelineProps {
  steps: StoryTimelineStep[];
  className?: string;
  orientation?: "horizontal" | "vertical";
}

export function StoryTimeline({ steps, className, orientation = "vertical" }: StoryTimelineProps) {
  if (orientation === "horizontal") {
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

  // Vertical orientation - displayed as a left-side number indicator
  return null; // We'll integrate the numbers directly into the step panels
}

// Vertical step number component for use alongside StepPanel
interface VerticalStepIndicatorProps {
  stepNumber: number;
  isLast?: boolean;
}

export function VerticalStepIndicator({ stepNumber, isLast = false }: VerticalStepIndicatorProps) {
  return (
    <div className="flex flex-col items-center mr-4">
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold bg-warm-brass text-deep-charcoal shadow-sm flex-shrink-0">
        {stepNumber}
      </div>
      {!isLast && (
        <div className="w-px flex-1 min-h-[40px] bg-warm-brass/30 mt-2" />
      )}
    </div>
  );
}
