# Enterprise connectors — initial S3 release

Phase 9 starts with a reusable source adapter (`list`, conditional `read`, `close`) and a durable sync pipeline. The first adapter reads S3 and S3-compatible buckets into existing knowledge bases. Google Drive, OneDrive, SharePoint, CRM, support and messaging adapters remain subsequent implementations.

Run `pnpm db:migrate` for migration 0011 and restart API, worker and web. Open **Connectors** in a workspace. Administrators register/change connections; builders can sync approved connections. Operators and analysts can inspect status. Sync requires current knowledge-management permission as well as connector-sync permission.

## Configure a source

1. Create a knowledge base in **Knowledge** and register its embedding model. Imported content inherits that knowledge base's access settings; remote S3 object ACLs are not mirrored per user.
2. Save a workspace secret in **Secrets** containing JSON:

   ```json
   {
     "accessKeyId": "YOUR_ACCESS_KEY_ID",
     "secretAccessKey": "YOUR_SECRET_ACCESS_KEY",
     "sessionToken": "OPTIONAL_TEMPORARY_TOKEN"
   }
   ```

   Omit `sessionToken` for permanent credentials. The secret is encrypted with workspace-bound authenticated encryption. Secret values are never returned by connector APIs. Rotation in Secrets takes effect for the next sync; expired session credentials must be replaced.

3. Approve the exact endpoint host in both API and worker:

   ```dotenv
   CONNECTOR_ALLOWED_HOSTS=s3.us-east-1.amazonaws.com
   CONNECTOR_PRIVATE_HOSTS=
   ```

   Preserve existing hosts when adding one. Endpoint grants are independent of model/tool/crawl grants. HTTPS is required for public endpoints. Trusted private S3-compatible endpoints require an exact host:port in `CONNECTOR_PRIVATE_HOSTS`; for local MinIO this may be `localhost:9000` with endpoint `http://localhost:9000`. Cloud outbound destination policy must also permit external hosts. Signed GET requests use the inherited proxy and TLS verification; redirects cannot silently expand endpoint access.

4. Add an S3 connector, select the knowledge base/credential, enter endpoint/region/bucket and prefix. A trailing slash selects a folder; an empty prefix selects the whole bucket. The maximum listed objects is 1–1000, default 100. This counts unsupported files too. Choose a narrow prefix for large buckets.
5. Use **Sync now** to verify access and import files. A completed sync means files were copied and ingestion jobs queued; parsing/embedding readiness is shown separately in Knowledge. Errors have safe codes and per-run counters, never raw S3 response bodies or credentials. Source location and target knowledge base are fixed after creation; create another connector to change them. Credential, name, listing limit, enabled state and schedule are editable with optimistic revisions.

Use least-privilege source credentials with `s3:ListBucket` on the selected bucket, restricted by `s3:prefix`, and `s3:GetObject` for the chosen prefix. No remote write/delete methods are exposed. Encrypted objects may require read-only KMS permissions. The application's internal storage credentials are separate from each connector's selected secret.

## Sync semantics

A complete bounded paginated listing precedes imports. ETag, size and modification time identify unchanged objects. Changed downloads use `If-Match` so an object changing between listing and download fails instead of importing an inconsistent snapshot. Supported formats use the existing document parsers (TXT, Markdown, CSV, JSON, HTML, PDF and supported Office formats). Non-document, empty and over-10-MB objects are skipped; a previously imported object that becomes ineligible is removed from retrieval after a successful scan.

Each remote key maps to one managed knowledge source per connector. Changes create a new source revision and cancel superseded ingestion. Only connector-managed sources absent from a complete successful scan are marked deleted and removed from retrieval; manual sources are preserved. Failed/truncated/over-limit scans never apply remote removals. A failed or cancelled sync may have imported some earlier files; per-run counters report this partial progress. A later sync resumes through the stored item fingerprints.

Source records and retrieved citations retain `s3://bucket/key` provenance and connector metadata. S3 origins are displayed as text rather than unauthenticated public download links. Manually deleting a managed source while the connector is active causes it to be recreated at the next sync. Pause/disconnect first if it should stay removed. Recreated sources use fresh storage identifiers so tombstone cleanup cannot erase a new upload.

Manual refresh and scheduled refresh (minimum 15 minutes, maximum seven days) use the same leased queue. One queued/running sync per connector is enforced in PostgreSQL. Workers heartbeat and reclaim expired jobs, with a three-attempt crash limit and a five-minute attempt deadline. Permission is checked at execution and before each object. Transient provider failures are recorded for manual retry or the next schedule; there is no automatic provider-error backoff within the durable job beyond bounded SDK retries. Crashes can repeat an uncommitted download. Cancel interrupts the active adapter call at the next heartbeat (up to ten seconds), and guarded writes prevent cancelled jobs from completing.

Pausing cancels active/queued syncs and retains imported knowledge. Disconnecting archives the connector, cancels work, retains history/imported sources and releases its credential reference so the secret can be deleted if nothing else uses it. Existing knowledge can be removed separately in Knowledge. Scheduled refresh uses the administrator who last configured the connection; if that actor loses access, refresh fails until an authorized administrator updates it.

## Current limits

One connector sync executes at a time per worker process. Sync history returns the latest 50 runs. Counts are stored at completion/failure. Large-bucket streaming, change feeds, retention/connection hard deletion, OAuth/assume-role renewal, source ACL mirroring, richer exclusion filters and other provider adapters remain extensions. Compatible endpoints are supported through path-style S3 requests; AWS production IAM/KMS/network behavior still needs live integration acceptance. Local MinIO and protocol-fixture tests establish the implemented pipeline, not enterprise production readiness.
