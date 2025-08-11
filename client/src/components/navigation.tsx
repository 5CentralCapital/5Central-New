import { Link, useLocation } from "wouter";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Menu } from "lucide-react";

export default function Navigation() {
  const [location] = useLocation();
  const [isScrolled, setIsScrolled] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 100);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const navItems = [
    { href: "/portfolio", label: "Portfolio" },
    { href: "/founder", label: "Founder" },
    { href: "/vision", label: "Vision" },
  ];

  const NavLink = ({ href, label, mobile = false }: { href: string; label: string; mobile?: boolean }) => {
    const isActive = location === href;
    const baseClasses = mobile 
      ? "block py-2 text-lg" 
      : "text-charcoal hover:text-accent-gold transition-colors duration-300 font-medium";
    
    return (
      <Link 
        href={href}
        className={`${baseClasses} ${isActive ? 'text-accent-gold' : ''}`}
        data-testid={`nav-link-${label.toLowerCase()}`}
        onClick={() => mobile && setIsOpen(false)}
      >
        {label}
      </Link>
    );
  };

  return (
    <nav className={`fixed w-full z-50 border-b border-gray-100 shadow-sm transition-all duration-300 ${
      isScrolled ? 'bg-white/98 backdrop-blur-sm' : 'bg-white/95 backdrop-blur-sm'
    }`} data-testid="main-navigation">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center" data-testid="logo-link">
            <img 
              src="/logo.jpg"
              alt="5Central Capital Logo" 
              className="h-12 object-contain"
            />
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center space-x-8">
            {navItems.map((item) => (
              <NavLink key={item.href} {...item} />
            ))}
            <Button 
              className="bg-gradient-to-r from-accent-gold to-bronze text-white px-6 py-2 rounded-lg font-semibold hover:shadow-lg transition-all duration-300 transform hover:-translate-y-0.5"
              data-testid="cta-investment-opportunities"
            >
              Investment Opportunities
            </Button>
          </div>

          {/* Mobile Navigation */}
          <Sheet open={isOpen} onOpenChange={setIsOpen}>
            <SheetTrigger asChild className="md:hidden">
              <Button variant="ghost" size="icon" data-testid="mobile-menu-trigger">
                <Menu className="h-6 w-6" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-64">
              <div className="flex flex-col space-y-4 mt-8">
                {navItems.map((item) => (
                  <NavLink key={item.href} {...item} mobile />
                ))}
                <Button 
                  className="bg-gradient-to-r from-accent-gold to-bronze text-white mt-4"
                  data-testid="mobile-cta-investment-opportunities"
                >
                  Investment Opportunities
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </nav>
  );
}
