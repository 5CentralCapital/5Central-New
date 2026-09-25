import { createRoot } from "react-dom/client";
import App from "./App";
import { appSurfaceForPath } from './lib/routes';
import "./index.css";
import { rentOpsAuthClient } from './features/rent-ops/auth';
import { preloadTenantSession } from './features/tenant-portal/startup';
import { preloadApplicantOptions } from './features/rent-ops-apply/startup';

// Restore the existing manager session while its route modules download.
if (appSurfaceForPath(window.location.pathname) === 'manager') {
  void rentOpsAuthClient.initialize().catch(() => undefined);
}
preloadTenantSession(window.location);
preloadApplicantOptions(window.location);

createRoot(document.getElementById("root")!).render(<App />);
