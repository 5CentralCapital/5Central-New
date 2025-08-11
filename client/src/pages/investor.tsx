import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";

export default function Investor() {
  const [initialInvestment, setInitialInvestment] = useState(100000);
  const [investmentDuration, setInvestmentDuration] = useState(5);
  const [formData, setFormData] = useState({ fullName: "", email: "" });

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Handle form submission here
    console.log("Investor list signup:", formData);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      {/* Hero Section */}
      <section className="relative py-20 px-4 text-center">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-5xl md:text-6xl font-serif font-bold text-primary mb-6">
            Investor Opportunities
          </h1>
          <div className="w-24 h-1 bg-accent-gold mx-auto mb-8"></div>
          <p className="text-2xl text-gray-600 mb-8">Coming Soon</p>
          <p className="text-lg text-gray-700 max-w-3xl mx-auto leading-relaxed">
            5Central Capital will soon be offering accredited investors the opportunity to co-invest in select real estate deals. 
            Join our investor list to be the first to know about upcoming opportunities.
          </p>
        </div>
      </section>

      {/* Investment Calculator */}
      <section className="py-16 px-4 bg-white">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-serif font-bold text-primary mb-4">Investment Return Calculator</h2>
            <p className="text-gray-600 max-w-2xl mx-auto">
              Calculate potential returns based on our target 30% annual return strategy. This calculator demonstrates the power of compound growth in real estate investments.
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

          {/* Calculation Methodology */}
          <Card className="mt-8 premium-border">
            <CardContent className="p-8">
              <h3 className="text-xl font-bold text-primary mb-4">Calculation Methodology</h3>
              <ul className="space-y-2 text-gray-700">
                <li>• Based on 30% target annual return strategy</li>
                <li>• Uses compound growth formula: A = P(1 + r)^t</li>
                <li>• Assumes consistent annual performance compounding</li>
                <li>• Conservative estimate based on market opportunities</li>
                <li>• Past performance does not guarantee future results</li>
              </ul>
            </CardContent>
          </Card>

          {/* Important Disclaimers */}
          <Card className="mt-8 bg-gray-50 border-gray-200">
            <CardContent className="p-8">
              <h3 className="text-xl font-bold text-red-600 mb-4">Important Disclaimers</h3>
              <ul className="space-y-2 text-gray-700">
                <li>• Calculations are for illustrative purposes only</li>
                <li>• Based on target return strategy, not guaranteed results</li>
                <li>• Actual returns may vary significantly from projections</li>
                <li>• Real estate investments carry inherent risks</li>
                <li>• Consult with financial advisors before investing</li>
                <li>• Market conditions and property performance may affect returns</li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Exclusive Investment Opportunities */}
      <section className="py-16 px-4 bg-gradient-to-r from-primary to-primary/90 text-white">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-serif font-bold mb-6">Exclusive Investment Opportunities</h2>
            <p className="text-xl max-w-3xl mx-auto leading-relaxed opacity-90">
              We're currently developing our investor portal and preparing to offer accredited investors the opportunity to participate in our high-return multifamily deals. 
              Our investment offerings will feature carefully selected properties with strong fundamentals and significant upside potential.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8 mb-12">
            <div className="text-center">
              <div className="text-3xl font-bold text-accent-gold mb-2">458.8%</div>
              <div className="text-lg font-semibold mb-2">Exceptional Returns</div>
              <div className="opacity-90">Target returns based on our proven track record of average cash-on-cash returns</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-accent-gold mb-2">15+</div>
              <div className="text-lg font-semibold mb-2">Experienced Team</div>
              <div className="opacity-90">Benefit from our deep market knowledge and proven track record across Florida and Connecticut</div>
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
                
                <Button
                  type="submit"
                  className="w-full bg-accent-gold hover:bg-accent-gold/90 text-primary font-bold py-3 text-lg"
                >
                  Join Investor List
                </Button>
              </form>
              
              <p className="text-sm text-gray-600 text-center mt-6">
                * Investment opportunities are limited to accredited investors only. Past performance does not guarantee future results.
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
              The investor portal is currently in development and will launch in early 2025.
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