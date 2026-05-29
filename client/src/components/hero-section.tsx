import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { useAnimatedCounter } from "@/hooks/use-animated-counter";
import { ArrowRight } from "lucide-react";

interface HeroSectionProps {
  totalPortfolioValue: number;
  totalUnits: number;
  avgEquityMultiple: number;
  avgReturn: number;
}

function AnimatedMetric({
  value,
  suffix = "",
  prefix = "",
  label,
  decimals = 0,
  delay = 0
}: {
  value: number;
  suffix?: string;
  prefix?: string;
  label: string;
  decimals?: number;
  delay?: number;
}) {
  const counter = useAnimatedCounter(value, {
    duration: 2000,
    delay,
    decimals
  });

  return (
    <div className="text-center">
      <div className="metric-value text-white mb-2">
        {prefix}
        {decimals > 0 ? counter.value.toFixed(decimals) : Math.round(counter.value).toLocaleString()}
        {suffix}
      </div>
      <div className="metric-label text-white/60">{label}</div>
    </div>
  );
}

export default function HeroSection({
  totalPortfolioValue,
  totalUnits,
  avgEquityMultiple,
  avgReturn
}: HeroSectionProps) {

  const formatValue = (value: number) => {
    if (!value || isNaN(value)) return 0;
    if (value >= 1000000) {
      return value / 1000000;
    }
    return value;
  };

  const getValueSuffix = (value: number) => {
    if (!value || isNaN(value)) return "";
    if (value >= 1000000) return "M";
    return "";
  };

  return (
    <section className="relative min-h-screen flex items-center" data-testid="hero-section">
      {/* Background Image with Overlay */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: 'url(https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?ixlib=rb-4.0.3&auto=format&fit=crop&w=2070&q=80)',
        }}
      />
      {/* Refined dark overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/60 to-black/80" />

      {/* Subtle grain texture overlay */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        }}
      />

      <div className="relative z-10 w-full">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 pt-32 pb-20">
          {/* Content */}
          <div className="max-w-4xl">
            {/* Subtle tagline */}
            <p className="text-warm-brass text-sm uppercase tracking-[0.3em] mb-6 fade-in-up" style={{ animationDelay: '0.1s' }}>
              Tampa-Based Investment Firm
            </p>

            {/* Main headline */}
            <h1 className="text-white mb-8 fade-in-up" style={{ animationDelay: '0.2s' }} data-testid="hero-title">
              Building Wealth Through<br />
              <span className="text-warm-brass italic">Strategic</span> Real Estate
            </h1>

            {/* Description */}
            <p className="text-xl md:text-2xl text-white/70 leading-relaxed mb-12 max-w-2xl font-light fade-in-up" style={{ animationDelay: '0.3s' }} data-testid="hero-description">
              High-return multifamily acquisitions with proven value creation through disciplined execution and strategic financing.
            </p>

            {/* CTA Buttons */}
            <div className="flex flex-col sm:flex-row gap-4 mb-20 fade-in-up" style={{ animationDelay: '0.4s' }}>
              <Link href="/portfolio">
                <Button
                  className="btn-accent group"
                  data-testid="button-view-portfolio"
                >
                  View Portfolio
                  <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
                </Button>
              </Link>
              <Link href="/investor">
                <Button
                  className="btn-outline border-white/30 text-white hover:bg-white hover:text-deep-charcoal"
                  data-testid="button-investment-opportunities"
                >
                  Investment Opportunities
                </Button>
              </Link>
            </div>
          </div>

          {/* Metrics Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-12 pt-12 border-t border-white/10 stagger-children" data-testid="hero-metrics">
            <AnimatedMetric
              value={formatValue(totalPortfolioValue)}
              prefix="$"
              suffix={getValueSuffix(totalPortfolioValue)}
              label="AUM"
              decimals={1}
              delay={600}
            />
            <AnimatedMetric
              value={totalUnits || 0}
              label="Multifamily Units"
              delay={700}
            />
            <AnimatedMetric
              value={avgEquityMultiple || 0}
              suffix="x"
              label="Avg Equity Multiple"
              decimals={2}
              delay={800}
            />
            <AnimatedMetric
              value={avgReturn || 0}
              suffix="%"
              label="Avg IRR"
              decimals={1}
              delay={900}
            />
          </div>
        </div>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 text-white/40">
        <span className="text-xs uppercase tracking-[0.2em]">Scroll</span>
        <div className="w-px h-8 bg-gradient-to-b from-white/40 to-transparent" />
      </div>
    </section>
  );
}
