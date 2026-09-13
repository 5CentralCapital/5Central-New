import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { rentOpsAuthClient } from './features/rent-ops/auth';

// Restore the existing manager session while its route modules download.
if (window.location.pathname === '/ops' || window.location.pathname.startsWith('/ops/')) {
  void rentOpsAuthClient.initialize().catch(() => undefined);
}

createRoot(document.getElementById("root")!).render(<App />);
