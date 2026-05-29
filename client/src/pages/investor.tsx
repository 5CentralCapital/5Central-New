import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";

export default function Investor() {
  const [initialInvestment, setInitialInvestment] = useState(100000);
  const [investmentDuration, setInvestmentDuration] = useState(5);
  const [formData, setFormData] = useState({
    fullName: "",
    email: "",
    phone: "",
    company: "",
    investableCapital: "100000",
    accreditedStatus: "unknown",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const calculateReturns = () => {
    const targetReturn = 0.30;
    const finalValue = initialInvestment * Math.pow(1 + targetReturn, investmentDuration);
    const totalReturns = finalValue - initialInvestment;
    const returnMultiple = finalValue / initialInvestment;
    const averageAnnualGain = totalReturns / investmentDuration;
    
    return {
      finalValue,
      totalReturns,
      returnMultiple,
      averageAnnualGain
    };
  };

  const results = calculateReturns();

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    const [firstName, ...lastParts] = formData.fullName.trim().split(/\s+/);
    const lastName = lastParts.join(" ") || "-";

    try {
      const response = await fetch("/api/investor-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          email: formData.email,
          phone: formData.phone || null,
          company: formData.company || null,
          investableCapital: formData.investableCapital,
          accreditedStatus: formData.accreditedStatus,
          source: "website",
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Signup failed");
      }

      toast({
        title: "You're on the list",
        description: `Got it. We'll use ${formData.email} for investor updates and deal follow-up.`,
      });

      setFormData({
        fullName: "",
        email: "",
        phone: "",
        company: "",
        investableCapital: "100000",
        accreditedStatus: "unknown",
      });
    } catch (error) {
      toast({
        title: "Signup did not go through",
        description: error instanceof Error ? error.message : "Try again or email michael@5central.capital.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen pt-16 bg-gradient-to-b from-gray-50 to-white">
      {/* Hero Section */}
      <section className="relative py-20 px-4 text-center">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-5xl md:text-6xl font-serif font-bold text-primary mb-6">
            Investor Opportunities
          </h1>
          <div className="w-24 h-1 bg-accent-gold mx-auto mb-8"></div>
          <p className="text-lg text-gray-700 max-w-3xl mx-auto leading-relaxed">
            Join the investor list for direct updates on new multifamily deals, refinance progress, and source-file-backed portfolio reporting.
          </p>
        </div>
      </section>

      {/* Investment Calculator */}
      <section className="py-16 px-4 bg-white">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-serif font-bold text-primary mb-4">Investment Return Calculator</h2>
            <p className="text-gray-600 max-w-2xl mx-auto">
              A simple target-case calculator for the private-capital model. It is planning math, not a promised return.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            {/* Calculator Controls */}
            <Card className="premium-border">
              <CardContent className="p-8">
                <div className="space-y-8">
                  <div>
                    <Label className="text-lg font-semibold text-primary mb-4 block">
                      Initial Investment Amount
                    </Label>
                    <div className="space-y-4">
                      <div className="text-3xl font-bold text-accent-gold text-center">
                        {formatCurrency(initialInvestment)}
                      </div>
                      <Slider
                        value={[initialInvestment]}
                        onValueChange={(value) => setInitialInvestment(value[0])}
                        max={500000}
                        min={50000}
                        step={25000}
                        className="w-full"
                      />
                      <div className="flex justify-between text-sm text-gray-500">
                        <span>$50K</span>
                        <span>$100K</span>
                        <span>$250K</span>
                        <span>$500K</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <Label className="text-lg font-semibold text-primary mb-4 block">
                      Investment Duration (Years)
                    </Label>
                    <div className="space-y-4">
                      <div className="text-3xl font-bold text-accent-gold text-center">
                        {investmentDuration} years
                      </div>
                      <Slider
                        value={[investmentDuration]}
                        onValueChange={(value) => setInvestmentDuration(value[0])}
                        max={10}
                        min={2}
                        step={1}
                        className="w-full"
                      />
                      <div className="flex justify-between text-sm text-gray-500">
                        <span>2 years</span>
                        <span>3 years</span>
                        <span>5 years</span>
                        <span>7 years</span>
                        <span>10 years</span>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Results */}
            <Card className="premium-border">
              <CardContent className="p-8">
                <h3 className="text-2xl font-bold text-primary mb-6">Projected Results</h3>
                
                <div className="space-y-4">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Initial Investment:</span>
                    <span className="font-bold text-primary">{formatCurrency(initialInvestment)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Investment Duration:</span>
                    <span className="font-bold text-primary">{investmentDuration} years</span>
                  </div>
                  <div className="flex justify-between border-t pt-4">
                    <span className="text-gray-600">Projected Final Value:</span>
                    <span className="font-bold text-accent-gold text-xl">{formatCurrency(results.finalValue)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Total Returns:</span>
                    <span className="font-bold text-accent-gold text-xl">{formatCurrency(results.totalReturns)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Return Multiple:</span>
                    <span className="font-bold text-accent-gold text-xl">{results.returnMultiple.toFixed(1)}x</span>
                  </div>
                </div>

                <div className="mt-8 pt-8 border-t">
                  <div className="grid grid-cols-2 gap-4 text-center">
                    <div>
                      <div className="text-2xl font-bold text-accent-gold">
                        {formatCurrency(results.averageAnnualGain)}
                      </div>
                      <div className="text-sm text-gray-600">Average Annual Gain</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-accent-gold">30%</div>
                      <div className="text-sm text-gray-600">Target Annual Return</div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Compact Disclaimers and Methodology */}
          <div className="mt-6 p-4 bg-gray-50 border border-gray-200 rounded-lg">
            <details className="mb-3">
              <summary className="text-sm font-semibold text-gray-600 cursor-pointer hover:text-primary">
                Calculation Methodology
              </summary>
              <div className="mt-2 text-xs text-gray-600 space-y-1">
                <div>• Based on a 30% annual target case</div>
                <div>• Uses compound growth formula: A = P(1 + r)^t</div>
                <div>• Assumes consistent annual performance compounding</div>
                <div>• Built for planning and sensitivity review, not a guarantee</div>
              </div>
            </details>
            
            <details>
              <summary className="text-sm font-semibold text-red-600 cursor-pointer hover:text-red-700">
                Important Disclaimers
              </summary>
              <div className="mt-2 text-xs text-gray-600 space-y-1">
                <div>• Calculations are for illustrative purposes only</div>
                <div>• Based on target return strategy, not guaranteed results</div>
                <div>• Actual returns may vary significantly from projections</div>
                <div>• Real estate investments carry inherent risks</div>
                <div>• Market conditions and property performance may affect returns</div>
                <div>• Past performance does not guarantee future results</div>
              </div>
            </details>
          </div>
        </div>
      </section>

      {/* Exclusive Investment Opportunities */}
      <section className="py-16 px-4 bg-gradient-to-r from-primary to-primary/90 text-white">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-serif font-bold mb-6">Exclusive Investment Opportunities</h2>
            <p className="text-xl max-w-3xl mx-auto leading-relaxed opacity-90">
              The next capital stack is being built around Florida value-add multifamily: clear basis, clear rehab plan, clear refinance path, and direct sponsor reporting.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8 mb-12">
            <div className="text-center">
              <div className="text-3xl font-bold text-accent-gold mb-2">3.0x+</div>
              <div className="text-lg font-semibold mb-2">Avg Equity Multiple</div>
              <div className="opacity-90">Target equity multiples based on our proven track record of value-add investments</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-accent-gold mb-2">6+</div>
              <div className="text-lg font-semibold mb-2">Years Experience</div>
              <div className="opacity-90">Founder-led with deep market knowledge and proven track record across Florida and Connecticut</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-accent-gold mb-2">VIP</div>
              <div className="text-lg font-semibold mb-2">Exclusive Access</div>
              <div className="opacity-90">Limited partnerships on hand-selected deals with institutional-quality due diligence</div>
            </div>
          </div>
        </div>
      </section>

      {/* Join Investor List */}
      <section className="py-16 px-4 bg-white">
        <div className="max-w-2xl mx-auto">
          <Card className="premium-border">
            <CardContent className="p-8">
              <div className="text-center mb-8">
                <h2 className="text-3xl font-serif font-bold text-primary mb-4">Join Our Investor List</h2>
                <p className="text-gray-600">
                  Real form. It writes straight to the investor CRM.
                </p>
              </div>
              
              <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                  <Label htmlFor="fullName" className="text-lg font-semibold text-primary">
                    Full Name
                  </Label>
                  <Input
                    id="fullName"
                    type="text"
                    value={formData.fullName}
                    onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                    className="mt-2"
                    required
                  />
                </div>
                
                <div>
                  <Label htmlFor="email" className="text-lg font-semibold text-primary">
                    Email Address
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="mt-2"
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="phone" className="text-lg font-semibold text-primary">
                    Phone
                  </Label>
                  <Input
                    id="phone"
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="mt-2"
                  />
                </div>

                <div>
                  <Label htmlFor="company" className="text-lg font-semibold text-primary">
                    Company
                  </Label>
                  <Input
                    id="company"
                    type="text"
                    value={formData.company}
                    onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                    className="mt-2"
                  />
                </div>

                <div>
                  <Label htmlFor="investableCapital" className="text-lg font-semibold text-primary">
                    Investable Capital
                  </Label>
                  <select
                    id="investableCapital"
                    value={formData.investableCapital}
                    onChange={(e) => setFormData({ ...formData, investableCapital: e.target.value })}
                    className="mt-2 w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="50000">$50K</option>
                    <option value="100000">$100K</option>
                    <option value="250000">$250K</option>
                    <option value="500000">$500K+</option>
                  </select>
                </div>

                <div>
                  <Label htmlFor="accreditedStatus" className="text-lg font-semibold text-primary">
                    Accredited Status
                  </Label>
                  <select
                    id="accreditedStatus"
                    value={formData.accreditedStatus}
                    onChange={(e) => setFormData({ ...formData, accreditedStatus: e.target.value })}
                    className="mt-2 w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="unknown">Not sure yet</option>
                    <option value="self_reported">Accredited</option>
                    <option value="not_accredited">Not accredited</option>
                  </select>
                </div>
                
                <Button
                  type="submit"
                  className="w-full bg-accent-gold hover:bg-accent-gold/90 text-primary font-bold py-3 text-lg"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Submitting..." : "Join Investor List"}
                </Button>
              </form>
              
              <p className="text-sm text-gray-600 text-center mt-6">
                Investment opportunities may be limited by accreditation status and deal structure.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* What to Expect */}
      <section className="py-16 px-4 bg-gray-50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-serif font-bold text-primary mb-6">What to Expect</h2>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            <Card className="premium-border">
              <CardContent className="p-8">
                <h3 className="text-2xl font-bold text-primary mb-6">Investor Portal Features</h3>
                <ul className="space-y-3 text-gray-700">
                  <li>• Private deal presentations and financial projections</li>
                  <li>• Regular property updates and performance reports</li>
                  <li>• Secure document sharing and investment tracking</li>
                  <li>• Direct communication with the investment team</li>
                </ul>
              </CardContent>
            </Card>

            <Card className="premium-border">
              <CardContent className="p-8">
                <h3 className="text-2xl font-bold text-primary mb-6">Investment Structure</h3>
                <ul className="space-y-3 text-gray-700">
                  <li>• Minimum investments starting at $50K-$100K</li>
                  <li>• Quarterly distributions and annual reports</li>
                  <li>• 3-5 year typical hold periods</li>
                  <li>• Professional property management included</li>
                </ul>
              </CardContent>
            </Card>
          </div>

          <div className="text-center mt-12">
            <p className="text-lg text-gray-600 mb-6">
              The investor portal is currently in development and will launch in 2026.
            </p>
            <Button
              className="bg-primary hover:bg-primary/90 text-white px-8 py-3 text-lg"
              disabled
            >
              Preview Investor Portal (Coming Soon)
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
