# Enterprise connectors — S3 and Google Drive

Phase 9 starts with a reusable source adapter (`list`, conditional `read`, `close`) and a durable sync pipeline. Adapters read S3/S3-compatible buckets and Google Drive folders into existing knowledge bases. OneDrive, SharePoint, CRM, support and messaging adapters remain subsequent implementations.

Run `pnpm db:migrate` for migrations 0011 and 0012 and restart API, worker and web. Open **Connectors** in a workspace. Administrators register/change connections; builders can sync approved connections. Operators and analysts can inspect status. Sync requires current knowledge-management permission as well as connector-sync permission.

## Configure S3

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

## Configure Google Drive

1. Enable the Google Drive API in your Google Cloud project and create a service account. Download its JSON private key through your organization's approved credential process. Save that JSON as an encrypted workspace secret. The connector reads `client_email` and `private_key`; other standard service-account JSON fields are accepted but not used. The signing key must be RSA with at least 2048 bits. Do not paste credentials into logs or chat.
2. Share the selected folder with the service account's `client_email` as **Viewer**. The account must be able to list and read all intended descendants. Shared drives may require membership permitted by your administrator. Domain-wide delegation and user impersonation are not used.
3. Approve `www.googleapis.com,oauth2.googleapis.com` in `CONNECTOR_ALLOWED_HOSTS` on API and worker, preserving existing grants. Cloud outbound policy must also permit those hosts. Endpoints are fixed; credential JSON cannot override token or API URLs.
4. Open **Connectors → Add connector**, choose **Google Drive**, and select the knowledge base and service-account secret. Copy the folder ID from `https://drive.google.com/drive/folders/FOLDER_ID`. Choose whether to include subfolders; the maximum listed objects counts folders, shortcuts and unsupported files too. Folder, recursive selection and target knowledge base are fixed after registration.
5. Use **Sync now**. The worker signs a one-hour JWT with the `drive.readonly` scope and exchanges it for an access token. Tokens are cached only in memory for that adapter and refreshed before expiry. Secret rotation takes effect at the next sync. Revoking the account's key or folder access prevents further reads.

Google Docs export as TXT, Sheets as XLSX and Slides as PPTX. Other supported uploaded document formats download as binary files. Shortcuts and unsupported Google-native types are skipped; shortcuts do not expand folder access. Exported files must fit the same 10-MB download limit. Files larger than the limit fail exports safely. Empty exports fail the sync rather than replacing existing content with an empty document.

A complete paginated folder traversal precedes imports. Duplicate entries, repeated page tokens, incomplete searches, malformed metadata and exceeded inventory limits fail without applying removals. The selected folder must still exist and be readable at the end of inventory. Fingerprints include file ID, version, modification time, name, type, size, checksum and parents. Binary downloads validate size and MD5; exports validate metadata before and after download. Changes during download fail the sync. Citations retain `https://drive.google.com/file/d/FILE_ID/view` origins.

Drive traversal is a bounded full scan, not a provider-wide transactional snapshot or change feed. Only files visible to the selected service account are inventoried. Files moved out, trashed or no longer visible may be removed from managed retrieval after a complete successful scan. Per-user Google ACLs are not mirrored: select a folder whose content is appropriate for the destination knowledge base audience. A loss of folder access fails rather than treating the folder as empty.

## Sync semantics

A complete bounded paginated listing precedes imports. ETag, size and modification time identify unchanged objects. Changed downloads use `If-Match` so an object changing between listing and download fails instead of importing an inconsistent snapshot. Supported formats use the existing document parsers (TXT, Markdown, CSV, JSON, HTML, PDF and supported Office formats). Non-document, empty and over-10-MB objects are skipped; a previously imported object that becomes ineligible is removed from retrieval after a successful scan.

Each remote key maps to one managed knowledge source per connector. Changes create a new source revision and cancel superseded ingestion. Only connector-managed sources absent from a complete successful scan are marked deleted and removed from retrieval; manual sources are preserved. Failed/truncated/over-limit scans never apply remote removals. A failed or cancelled sync may have imported some earlier files; per-run counters report this partial progress. A later sync resumes through the stored item fingerprints.

Source records and retrieved citations retain `s3://bucket/key` provenance and connector metadata. S3 origins are displayed as text rather than unauthenticated public download links. Manually deleting a managed source while the connector is active causes it to be recreated at the next sync. Pause/disconnect first if it should stay removed. Recreated sources use fresh storage identifiers so tombstone cleanup cannot erase a new upload.

Manual refresh and scheduled refresh (minimum 15 minutes, maximum seven days) use the same leased queue. One queued/running sync per connector is enforced in PostgreSQL. Workers heartbeat and reclaim expired jobs, with a three-attempt crash limit and a five-minute attempt deadline. Permission is checked at execution and before each object. Transient provider failures are recorded for manual retry or the next schedule; there is no automatic provider-error backoff within the durable job beyond bounded SDK retries. Crashes can repeat an uncommitted download. Cancel interrupts the active adapter call at the next heartbeat (up to ten seconds), and guarded writes prevent cancelled jobs from completing.

Pausing cancels active/queued syncs and retains imported knowledge. Disconnecting archives the connector, cancels work, retains history/imported sources and releases its credential reference so the secret can be deleted if nothing else uses it. Existing knowledge can be removed separately in Knowledge. Scheduled refresh uses the administrator who last configured the connection; if that actor loses access, refresh fails until an authorized administrator updates it.

## Current limits

One connector sync executes at a time per worker process. Sync history returns the latest 50 runs. Counts are stored at completion/failure. Large-bucket streaming, change feeds, retention/connection hard deletion, interactive user OAuth/assume-role renewal, source ACL mirroring, richer exclusion filters and other provider adapters remain extensions. Compatible endpoints are supported through path-style S3 requests; AWS production IAM/KMS/network behavior and live Google Cloud service-account/shared-drive behavior still need live integration acceptance. Local MinIO and protocol-fixture tests establish the implemented pipeline, not enterprise production readiness.
