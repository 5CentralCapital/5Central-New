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
          setLocation("/portfolio");
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">
            Welcome Back
          </DialogTitle>
          <DialogDescription>
            Sign in to access your account
          </DialogDescription>
        </DialogHeader>

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
      </DialogContent>
    </Dialog>
  );
}
