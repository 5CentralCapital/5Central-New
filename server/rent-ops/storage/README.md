# Private document storage core

This module is the integration seam for verified Rent Operations document
binaries. It has no Rent Manager, database, or vendor object-store dependency.

`createLocalStagingStore` accepts an existing absolute directory that is
dedicated to this store and mode `0700`. The caller should pass the repository
or worktree root as `repositoryRoot` so an accidental in-repository staging
root is rejected. `createPrivateLocalStagingRoot` is the explicit provisioning
helper when that directory does not exist yet.

Objects are addressed only as `sha256:<64 lowercase hex digits>`. Filenames,
source IDs, import IDs, and content types never participate in the logical key.
The local implementation opens source files once with `O_NOFOLLOW`, validates
the descriptor, streams and hashes from that descriptor, writes a private
0600 temp, fsyncs it, atomically publishes it with a no-replace hard-link
operation, fsyncs the shard directory, and reopens/rehashes the published file.
The hard-link publication is used because Node does not expose
`renameat2(RENAME_NOREPLACE)`; it provides the required immutable no-overwrite
behavior for concurrent writers.

`createRuntimeReadAdapter` and `createReadOnlyObjectStoreAdapter` expose only
`stat`, `open`, `verify`, and `openVerified`; the last method hashes and opens
through one descriptor so callers do not create a verify-then-open replacement
window. Orphan inventory returns a redacted plan and the
compensating-cleanup API never deletes objects. A temp left after the
link-publication/crash window is marked removable only when its descriptor
identity is exactly the accepted object's one extra staging hard link; the
plan carries an opaque temp token, never a filename.

`createImporterStorageFacade` is the only RM-import file seam. It requires the
store to have been configured with an existing private `sourceRoot` and binds
every put to that root, so an import caller cannot pass an arbitrary absolute
private path. A future private versioned object store can implement
`PrivateVersionedObjectStoreClient` without adding a vendor SDK to this module;
its privilege probe must attest separate web-runtime, upload-writer, and
importer identities. The runtime identity is prefix-scoped Head/Get-only. Applicant
uploads use the dedicated upload-writer identity, which is limited to
Put-if-absent plus exact Head/Get verification. RM archive transfer uses the
separate importer identity. Every identity must explicitly deny list/delete;
the production probe must set `requireUploadWriter` so a read-only runtime can
never be reused for applicant writes.
