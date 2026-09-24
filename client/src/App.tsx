import { lazy, Suspense } from "react";
import { Switch, Route, useLocation } from "wouter";
import { AuthProvider } from "@/contexts/auth-context";
import { ACCOUNT_ENTRY_ROUTES } from "@/components/account-entry";
import ProtectedRoute from "@/components/protected-route";
import { appSurfaceForPath, type AppSurface } from "@/lib/routes";
const AppProviders = lazy(() => import("@/components/app-providers"));
const Toaster = lazy(() => import("@/components/ui/toaster").then(module => ({ default: module.Toaster })));
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
const EndUserLicenseAgreement = lazy(() => import("@/pages/legal/eula"));
const PrivacyPolicy = lazy(() => import("@/pages/legal/privacy"));
const QuickBooksDisconnected = lazy(() => import("@/pages/quickbooks-disconnected"));

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
      <Route path="/legal/eula" component={EndUserLicenseAgreement} />
      <Route path="/legal/privacy" component={PrivacyPolicy} />
      <Route path="/quickbooks/disconnected" component={QuickBooksDisconnected} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppContent({ surface }: { surface: AppSurface }) {
  return (
    <>
      {surface === "site" && <Suspense fallback={null}><Navigation /></Suspense>}
      {(surface === "site" || surface === "manager") && <Suspense fallback={null}><Toaster /></Suspense>}
      <Suspense fallback={<div role="status" className="p-6 text-sm">Loading…</div>}><Router /></Suspense>
    </>
  );
}

function App() {
  const [location] = useLocation();
  const surface = appSurfaceForPath(location);
  // These self-contained portals use their own account and form state. Avoid
  // downloading staff query, tooltip and toast libraries for their first page.
  if (surface === "tenant" || surface === "applicant") return <AppContent surface={surface} />;
  return (
    <Suspense fallback={<div role="status" className="p-6 text-sm">Loading…</div>}>
      <AppProviders>
        {surface === "manager" ? <AppContent surface={surface} /> : <AuthProvider restoreSession={["/admin", "/data-room", "/investor-dashboard"].includes(location)}><AppContent surface={surface} /></AuthProvider>}
      </AppProviders>
    </Suspense>
  );
}

export default App;
