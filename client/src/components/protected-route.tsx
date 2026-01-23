import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/auth-context";

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: ("admin" | "investor")[];
}

export default function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (isLoading) return;

    if (!user) {
      // Not authenticated, redirect to home
      setLocation("/");
      return;
    }

    if (allowedRoles && !allowedRoles.includes(user.role)) {
      // User doesn't have the required role, redirect to appropriate dashboard
      if (user.role === "admin") {
        setLocation("/portfolio");
      } else {
        setLocation("/investor-dashboard");
      }
    }
  }, [user, isLoading, allowedRoles, setLocation]);

  // Show nothing while loading
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Not authenticated
  if (!user) {
    return null;
  }

  // Check role access
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return null;
  }

  return <>{children}</>;
}
