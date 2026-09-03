import { Link, useLocation } from "wouter";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Menu, LogOut } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import LoginModal from "@/components/login-modal";

export default function Navigation() {
  const [location, setLocation] = useLocation();
  const [isScrolled, setIsScrolled] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const { user, logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    setLocation("/");
  };

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const navItems = [
    { href: "/portfolio", label: "Portfolio" },
    { href: "/flips", label: "Flips" },
    { href: "/founder", label: "Founder" },
    { href: "/vision", label: "Vision" },
    { href: "/investor", label: "Investor" },
  ];

  const NavLink = ({ href, label, mobile = false }: { href: string; label: string; mobile?: boolean }) => {
    const isActive = location === href;

    if (mobile) {
      return (
        <Link
          href={href}
          className={`block py-3 text-lg font-medium tracking-wide transition-colors duration-300 ${
            isActive ? 'text-warm-brass' : 'text-foreground hover:text-warm-brass'
          }`}
          data-testid={`nav-link-${label.toLowerCase()}`}
          onClick={() => setIsOpen(false)}
        >
          {label}
        </Link>
      );
    }

    return (
      <Link
        href={href}
        className={`nav-link text-sm uppercase tracking-wider font-medium ${isActive ? 'active text-primary' : ''}`}
        data-testid={`nav-link-${label.toLowerCase()}`}
      >
        {label}
      </Link>
    );
  };

  return (
    <nav
      className={`fixed w-full z-50 transition-all duration-500 ${
        isScrolled
          ? 'bg-background/80 backdrop-blur-xl border-b border-border/50 shadow-sm'
          : 'bg-transparent'
      }`}
      data-testid="main-navigation"
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="flex justify-between items-center h-20">
          {/* Logo */}
          <Link href="/" className="flex items-center group" data-testid="logo-link">
            <div className="font-serif text-xl md:text-2xl tracking-tight">
              <span className="font-medium text-foreground">5Central</span>
              <span className="text-warm-brass ml-1 font-normal italic">Capital</span>
            </div>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden lg:flex items-center gap-10">
            {navItems.map((item) => (
              <NavLink key={item.href} {...item} />
            ))}
            {user ? (
              <div className="flex items-center gap-4 ml-4">
                <Link href="/data-room" className="text-sm text-muted-foreground hover:text-warm-brass font-medium">
                  Data Room
                </Link>
                {user.role === "admin" ? (
                  <Link href="/admin" className="text-sm text-warm-brass hover:underline font-medium cursor-pointer">
                    {user.firstName}
                  </Link>
                ) : (
                  <Link href="/investor-dashboard" className="text-sm text-muted-foreground hover:underline cursor-pointer">
                    {user.firstName}
                  </Link>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleLogout}
                  className="flex items-center gap-2"
                >
                  <LogOut className="h-4 w-4" />
                  Log Out
                </Button>
              </div>
            ) : (
              <Button
                className="btn-accent ml-4"
                data-testid="cta-login"
                onClick={() => setIsLoginModalOpen(true)}
              >
                Log In
              </Button>
            )}
          </div>

          {/* Mobile Navigation */}
          <Sheet open={isOpen} onOpenChange={setIsOpen}>
            <SheetTrigger asChild className="lg:hidden">
              <Button
                variant="ghost"
                size="icon"
                className="hover:bg-transparent"
                data-testid="mobile-menu-trigger"
              >
                <Menu className="h-6 w-6" />
                <span className="sr-only">Open navigation</span>
              </Button>
            </SheetTrigger>
            <SheetContent
              side="right"
              className="w-full sm:w-80 bg-background border-l border-border p-0"
            >
              <SheetTitle className="sr-only">Site navigation</SheetTitle>
              <SheetDescription className="sr-only">Navigate the 5Central Capital website.</SheetDescription>
              <div className="flex flex-col h-full">
                {/* Mobile Header */}
                <div className="flex items-center justify-between px-6 py-5 border-b border-border">
                  <div className="font-serif text-xl tracking-tight">
                    <span className="font-medium">5Central</span>
                    <span className="text-warm-brass ml-1 italic">Capital</span>
                  </div>
                </div>

                {/* Mobile Links */}
                <div className="flex-1 px-6 py-8">
                  <div className="space-y-1">
                    {navItems.map((item) => (
                      <NavLink key={item.href} {...item} mobile />
                    ))}
                  </div>

                  <div className="mt-10 pt-8 border-t border-border">
                    {user ? (
                      <div className="space-y-4">
                        <Link
                          href={user.role === "admin" ? "/admin" : "/investor-dashboard"}
                          className={`block text-sm font-medium ${user.role === "admin" ? "text-warm-brass" : "text-muted-foreground"}`}
                          onClick={() => setIsOpen(false)}
                        >
                          {user.firstName} {user.lastName} → Dashboard
                        </Link>
                        <Link
                          href="/data-room"
                          className="block text-sm font-medium text-muted-foreground"
                          onClick={() => setIsOpen(false)}
                        >
                          Private Data Room
                        </Link>
                        <Button
                          variant="outline"
                          className="w-full flex items-center justify-center gap-2"
                          onClick={() => {
                            handleLogout();
                            setIsOpen(false);
                          }}
                        >
                          <LogOut className="h-4 w-4" />
                          Log Out
                        </Button>
                      </div>
                    ) : (
                      <Button
                        className="btn-accent w-full"
                        data-testid="mobile-cta-login"
                        onClick={() => {
                          setIsOpen(false);
                          setIsLoginModalOpen(true);
                        }}
                      >
                        Log In
                      </Button>
                    )}
                  </div>
                </div>

                {/* Mobile Footer */}
                <div className="px-6 py-6 border-t border-border">
                  <p className="text-sm text-muted-foreground">
                    Tampa, FL
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    michael@5central.capital
                  </p>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      <LoginModal open={isLoginModalOpen} onOpenChange={setIsLoginModalOpen} />
    </nav>
  );
}
