import { lazy, Suspense } from "react";

const Workspace = lazy(() => import("./workspace").then(module => ({ default: module.ReviewQueueWorkspace })));

/** Navigation mount point with no required props; resolves the company itself. */
export function ReviewQueueEntry({ organizationId, propertyId }: { organizationId?: string; propertyId?: string | null } = {}) {
  return <Suspense fallback={<div className="rm-empty" role="status">Loading review cases…</div>}>
    <Workspace organizationId={organizationId} propertyId={propertyId} />
  </Suspense>;
}

export default ReviewQueueEntry;
