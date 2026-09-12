import { lazy, Suspense } from "react";
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/auth-context";
import { ACCOUNT_ENTRY_ROUTES } from "@/components/account-entry";
import ProtectedRoute from "@/components/protected-route";
const Navigation = lazy(() => import("@/components/navigation"));
const Home = lazy(() => import("@/pages/home"));
const Founder = lazy(() => import("@/pages/founder"));
const Vision = lazy(() => import("@/pages/vision"));
const Portfolio = lazy(() => import("@/pages/portfolio"));
const Flips = lazy(() => import("@/pages/flips"));
const PropertyStory = lazy(() => import("@/pages/property-story"));
const Investor = lazy(() => import("@/pages/investor"));
const DataRoom = lazy(() => import("@/pages/data-room"));
const InvestorDashboard = lazy(() => import("@/pages/investor-dashboard"));
const AdminDashboard = lazy(() => import("@/pages/admin-dashboard"));
const NotFound = lazy(() => import("@/pages/not-found"));
const RentOpsPage = lazy(() => import("@/pages/rent-ops"));
const RentOpsApplyPage = lazy(() => import("@/pages/rent-ops-apply"));
const TenantPortalPage = lazy(() => import("@/pages/tenant-portal"));

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/founder" component={Founder} />
      <Route path="/vision" component={Vision} />
      <Route path="/flips" component={Flips} />
      <Route path="/portfolio/:slug" component={PropertyStory} />
      <Route path="/portfolio" component={Portfolio} />
      <Route path="/investor" component={Investor} />
      <Route path="/data-room">
        <ProtectedRoute allowedRoles={["admin", "investor"]}>
          <DataRoom />
        </ProtectedRoute>
      </Route>
      <Route path="/investor-dashboard">
        <ProtectedRoute allowedRoles={["investor"]}>
          <InvestorDashboard />
        </ProtectedRoute>
      </Route>
      <Route path="/admin">
        <ProtectedRoute allowedRoles={["admin"]}>
          <AdminDashboard />
        </ProtectedRoute>
      </Route>
      <Route path={ACCOUNT_ENTRY_ROUTES.manager} component={RentOpsPage} />
      <Route path={ACCOUNT_ENTRY_ROUTES.resident} component={TenantPortalPage} />
      <Route path="/apply" component={RentOpsApplyPage} />
      <Route path="/apply/:propertySlug" component={RentOpsApplyPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppContent() {
  const [location] = useLocation();
  const isApplicantRoute = location === "/apply" || location.startsWith("/apply/");
  const isRentOpsRoute = location === "/ops" || location.startsWith("/ops/");
  const isTenantRoute = location === "/tenant";
  return (
    <>
      {!isApplicantRoute && !isRentOpsRoute && !isTenantRoute && <Suspense fallback={null}><Navigation /></Suspense>}
      <Toaster />
      <Suspense fallback={<div role="status" className="p-6 text-sm">Loading…</div>}><Router /></Suspense>
    </>
  );
}

function App() {
  const [location] = useLocation();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {location === "/tenant" || location === "/ops" || location.startsWith("/ops/") ? <AppContent /> : <AuthProvider><AppContent /></AuthProvider>}
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
