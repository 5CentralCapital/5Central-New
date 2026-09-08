import { useState } from "react";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth-context";

interface LoginModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MANAGER_PORTAL_URL = "https://5-central-new.replit.app/ops";
const RESIDENT_PORTAL_URL = "https://5-central-new.replit.app/tenant";

export default function LoginModal({ open, onOpenChange }: LoginModalProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { login } = useAuth();
  const [, setLocation] = useLocation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    const result = await login(email, password);

    if (result.success) {
      onOpenChange(false);
      setEmail("");
      setPassword("");
      // Redirect based on role will be handled by the auth context user change
      // We need to refetch and redirect
      const response = await fetch("/api/auth/me", { credentials: "include" });
      if (response.ok) {
        const data = await response.json();
        if (data.user.role === "admin") {
          setLocation("/admin");
        } else {
          setLocation("/investor-dashboard");
        }
      }
    } else {
      setError(result.error || "Login failed");
    }

    setIsLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">
            Welcome Back
          </DialogTitle>
          <DialogDescription>
            Choose the portal that matches your account
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-4" aria-label="Portal selection">
          <p className="text-sm font-medium text-foreground">Manager or Resident</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              asChild
              variant="outline"
              className="h-auto justify-start px-4 py-3 text-left"
            >
              <a href={MANAGER_PORTAL_URL}>
                <span className="flex flex-col items-start">
                  <span className="font-medium">Manager</span>
                  <span className="text-xs text-muted-foreground">Open Manager Dashboard</span>
                </span>
              </a>
            </Button>
            <Button
              asChild
              variant="outline"
              className="h-auto justify-start px-4 py-3 text-left"
            >
              <a href={RESIDENT_PORTAL_URL}>
                <span className="flex flex-col items-start">
                  <span className="font-medium">Resident</span>
                  <span className="text-xs text-muted-foreground">Open Resident Portal</span>
                </span>
              </a>
            </Button>
          </div>
        </div>

        <div className="border-t border-border mt-6 pt-6">
          <p className="text-sm font-medium text-foreground mb-3">Investor</p>
          <form onSubmit={handleSubmit} className="space-y-4 mt-4">
            {error && (
              <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>

            <Button
              type="submit"
              className="w-full btn-accent"
              disabled={isLoading}
            >
              {isLoading ? "Signing in..." : "Log In"}
            </Button>

            <p className="text-sm text-center text-muted-foreground mt-4">
              Need an account?{" "}
              <a
                href="mailto:michael@5central.capital"
                className="text-warm-brass hover:underline"
              >
                Contact us
              </a>
            </p>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
