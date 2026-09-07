import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/auth-context";
import Navigation from "@/components/navigation";
import ProtectedRoute from "@/components/protected-route";
import Home from "@/pages/home";
import Founder from "@/pages/founder";
import Vision from "@/pages/vision";
import Portfolio from "@/pages/portfolio";
import Flips from "@/pages/flips";
import PropertyStory from "@/pages/property-story";
import Investor from "@/pages/investor";
import DataRoom from "@/pages/data-room";
import InvestorDashboard from "@/pages/investor-dashboard";
import AdminDashboard from "@/pages/admin-dashboard";
import NotFound from "@/pages/not-found";
import RentOpsPage from "@/pages/rent-ops";
import RentOpsApplyPage from "@/pages/rent-ops-apply";
import TenantPortalPage from "@/pages/tenant-portal";

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
      <Route path="/ops" component={RentOpsPage} />
      <Route path="/tenant" component={TenantPortalPage} />
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
      {!isApplicantRoute && !isRentOpsRoute && !isTenantRoute && <Navigation />}
      <Toaster />
      <Router />
    </>
  );
}

function App() {
  const [location] = useLocation();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {location === "/tenant" ? <AppContent /> : <AuthProvider><AppContent /></AuthProvider>}
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
