# Enterprise connectors — S3, Google Drive, OneDrive and SharePoint

Phase 9 starts with a reusable source adapter (`list`, conditional `read`, `close`) and a durable sync pipeline. Adapters read S3/S3-compatible buckets, Google Drive, OneDrive for Business and SharePoint library folders into existing knowledge bases. CRM, support and messaging adapters remain subsequent implementations.

Run `pnpm db:migrate` for migrations 0011–0014 and restart API, worker and web. Open **Connectors** in a workspace. Administrators register/change connections; builders can sync approved connections. Operators and analysts can inspect status. Sync requires current knowledge-management permission as well as connector-sync permission.

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

## Configure OneDrive for Business

1. Register an application in the Microsoft Entra tenant that owns the drive. Grant read-only Microsoft Graph **application** permissions, such as `Files.Read.All`, with administrator consent. Where your organization supports narrower selected-resource application permissions, grant access only to the intended resource. No write permissions are needed. This release uses app-only credentials; personal Microsoft accounts and interactive delegated sign-in are not supported.
2. Save an encrypted workspace JSON secret:

   ```json
   {
     "tenantId": "YOUR_DIRECTORY_TENANT_GUID",
     "clientId": "YOUR_APPLICATION_CLIENT_GUID",
     "clientSecret": "YOUR_CLIENT_SECRET_VALUE"
   }
   ```

   Use the client secret **value**, not its secret ID. Tenant and application IDs must be GUIDs; `common`, `organizations` and credential-supplied endpoint URLs are not accepted. Renew the application secret before expiry through Secrets. Each new sync reads the current credential.

3. Approve `graph.microsoft.com,login.microsoftonline.com` and the **exact download host** in `CONNECTOR_ALLOWED_HOSTS` on both API and worker, preserving existing hosts. OneDrive for Business commonly redirects to `YOUR_TENANT-my.sharepoint.com`; document libraries may use `YOUR_TENANT.sharepoint.com`. Approve the actual host used by your tenant, not a wildcard. The cloud outbound policy must also allow these destinations. Public HTTPS is required for download redirects; private-host exceptions cannot authorize them.
4. Obtain the drive and folder item IDs through authorized Microsoft Graph requests. For example, `GET /v1.0/users/USER_OBJECT_ID/drive?$select=id` identifies a user's provisioned business drive; `GET /v1.0/drives/DRIVE_ID/root?$select=id` identifies its root folder, and `GET /v1.0/drives/DRIVE_ID/items/FOLDER_ITEM_ID/children` lists descendants. These are Graph IDs, not browser sharing URLs or the literal word `root`. This release also accepts existing document-library drive IDs; The SharePoint connector provides guided site/library/folder discovery for these libraries.
5. In **Connectors → Add connector**, select **OneDrive for Business**, the knowledge base, application secret, drive ID and folder item ID. Choose recursive or direct-child inventory and a manual/scheduled refresh. Drive, folder, recursive selection and destination knowledge base stay fixed after creation. Run **Sync now** and then check source readiness in Knowledge.

Tokens are obtained at the fixed tenant-specific Microsoft login endpoint using `client_credentials` and `https://graph.microsoft.com/.default`. The app's consented permissions determine access; the adapter uses only Graph GET requests and token exchange POST requests. Tokens are held in memory and renewed before expiry.

Inventory walks bounded, complete child pages and refuses pagination outside the selected Graph drive/folder endpoint. It counts folders, shortcuts and unsupported entries against the limit; remote-item shortcuts are never followed. A failed page, access loss, duplicate item, invalid parent, looping next link or exceeded limit prevents remote removal reconciliation. Each successful scan can reconcile files that have moved out or become invisible to the application. Graph child listings are not a transactional snapshot or delta/change feed.

Files download as their original supported formats. The Graph content request may return a signed redirect: the adapter validates its host, makes a separate request **without Graph authorization**, and refuses further redirects. Signed download URLs are never saved as source URLs, fingerprint fields or error messages. File size, available SHA-256/SHA-1 checksums and metadata before/after download guard changed content. Retrieval citations use the stable `webUrl` supplied by Graph.

Imported documents inherit the selected knowledge base's access settings. Per-user OneDrive/SharePoint ACLs are not mirrored. Choose a source folder appropriate for that knowledge audience. Pausing, cancellation, schedules, incremental fingerprints, managed-only removal and disconnect retention use the same durable pipeline as S3 and Google Drive. Live Entra consent, tenant download hosts, sovereign clouds and production Microsoft access require separate acceptance; this release uses public-cloud Microsoft endpoints only.

## Configure SharePoint document libraries

1. Use a Microsoft Entra application credential as described for OneDrive. For site-scoped access, grant the Graph application `Sites.Selected` permission with administrator consent and arrange a separate **read** grant for the intended site through your Microsoft administrator. Consent alone does not provide site access. Broader read-only application permissions such as `Sites.Read.All` may be appropriate under your organization's access policy. The connector does not create permissions or request write access.
2. Save/select the encrypted JSON secret with `tenantId`, `clientId` and `clientSecret`. Approve `graph.microsoft.com`, `login.microsoftonline.com` and the actual download host, typically `YOUR_TENANT.sharepoint.com`, in `CONNECTOR_ALLOWED_HOSTS` on API and worker and in the cloud outbound policy. Discovery reads Graph only; the site URL is not used as an arbitrary HTTP destination.
3. Choose **SharePoint** under **Connectors → Add connector**. Enter a site URL such as `https://YOUR_TENANT.sharepoint.com/sites/Support` or a `/teams/...` site URL. Tenant root sites are supported too. Use the site URL, not a document sharing URL; query strings, fragments, credentials, private endpoints and non-public-cloud SharePoint hosts are rejected.
4. Click **Find site**, choose a visible **Document library**, browse subfolders and click **Use this folder**. Breadcrumb buttons return to earlier folders. The library root can be selected explicitly. Changing the credential, site URL or library clears the previous folder choice; a folder must be confirmed before saving.
5. Select recursive or direct-child sync and a refresh schedule, then save. Site, library, folder, recursive selection and destination knowledge base are immutable after creation. Run **Sync now**, then open Knowledge to inspect document readiness. Use an appropriate knowledge audience: imported content does not mirror individual SharePoint user permissions.

Discovery requires workspace connector-management permission and decrypts only the selected workspace credential. It resolves the supplied site directly rather than searching all sites, which supports scoped application grants. Library discovery is bounded to 100 libraries and folder browsing to 1000 child entries, including files and skipped shortcuts. Malformed, foreign or looping pagination fails rather than returning partial choices. A site with no visible libraries shows an access/setup message.

At sync time the worker checks that the library belongs to the selected accessible site before and after complete document inventory. A changed membership or lost permission fails without reconciling removals. Original files, incremental fingerprints, checksum/metadata guards, secure signed downloads, citations, schedules, cancellation and managed-source reconciliation reuse the OneDrive pipeline and its limits. The shared Graph client renews tokens in memory and never sends Graph authorization to signed download endpoints.

This slice covers document libraries and their supported files. SharePoint lists, site pages, broad tenant search, delegated sign-in, sovereign clouds, delta feeds and per-user ACL mirroring remain extensions. Live site grants, library enumeration and actual tenant downloads require Microsoft acceptance testing with configured credentials.

## Sync semantics

A complete bounded paginated listing precedes imports. ETag, size and modification time identify unchanged objects. Changed downloads use `If-Match` so an object changing between listing and download fails instead of importing an inconsistent snapshot. Supported formats use the existing document parsers (TXT, Markdown, CSV, JSON, HTML, PDF and supported Office formats). Non-document, empty and over-10-MB objects are skipped; a previously imported object that becomes ineligible is removed from retrieval after a successful scan.

Each remote key maps to one managed knowledge source per connector. Changes create a new source revision and cancel superseded ingestion. Only connector-managed sources absent from a complete successful scan are marked deleted and removed from retrieval; manual sources are preserved. Failed/truncated/over-limit scans never apply remote removals. A failed or cancelled sync may have imported some earlier files; per-run counters report this partial progress. A later sync resumes through the stored item fingerprints.

Source records and retrieved citations retain `s3://bucket/key` provenance and connector metadata. S3 origins are displayed as text rather than unauthenticated public download links. Manually deleting a managed source while the connector is active causes it to be recreated at the next sync. Pause/disconnect first if it should stay removed. Recreated sources use fresh storage identifiers so tombstone cleanup cannot erase a new upload.

Manual refresh and scheduled refresh (minimum 15 minutes, maximum seven days) use the same leased queue. One queued/running sync per connector is enforced in PostgreSQL. Workers heartbeat and reclaim expired jobs, with a three-attempt crash limit and a five-minute attempt deadline. Permission is checked at execution and before each object. Transient provider failures are recorded for manual retry or the next schedule; there is no automatic provider-error backoff within the durable job beyond bounded SDK retries. Crashes can repeat an uncommitted download. Cancel interrupts the active adapter call at the next heartbeat (up to ten seconds), and guarded writes prevent cancelled jobs from completing.

Pausing cancels active/queued syncs and retains imported knowledge. Disconnecting archives the connector, cancels work, retains history/imported sources and releases its credential reference so the secret can be deleted if nothing else uses it. Existing knowledge can be removed separately in Knowledge. Scheduled refresh uses the administrator who last configured the connection; if that actor loses access, refresh fails until an authorized administrator updates it.

## Current limits

One connector sync executes at a time per worker process. Sync history returns the latest 50 runs. Counts are stored at completion/failure. Large-bucket streaming, change feeds, retention/connection hard deletion, interactive user OAuth/assume-role renewal, source ACL mirroring, richer exclusion filters and other provider adapters remain extensions. Compatible endpoints are supported through path-style S3 requests; AWS production IAM/KMS/network behavior and live Google Cloud service-account/shared-drive behavior still need live integration acceptance. Local MinIO and protocol-fixture tests establish the implemented pipeline, not enterprise production readiness.

## Microsoft Teams channel messages

Select Microsoft Teams in Connectors and supply a Microsoft Graph team UUID and standard-channel ID (`19:…@thread.tacv2`). Use the shared Entra application JSON secret `{ "tenantId": "UUID", "clientId": "UUID", "clientSecret": "…" }`. Grant `Channel.ReadBasic.All` and `ChannelMessage.Read.All` application permissions with administrator consent. Approve `graph.microsoft.com` and `login.microsoftonline.com` in `CONNECTOR_ALLOWED_HOSTS` on API and worker. Access tokens renew in memory. This connector only reads channel metadata, messages and replies; it never sends messages. Private/shared channels, chats, files and interactive delegated sign-in are outside this slice.

## Slack channel messages

Select Slack and supply the workspace ID (`T…`) and channel ID (`C…` or `G…`). Save a JSON workspace secret `{ "token": "xoxp-…" }` containing the app's **user OAuth token**, with `channels:read`, `channels:history`, `groups:read` and `groups:history` as appropriate. The authorizing user must belong to the selected channel. Bot tokens cannot read channel replies through this flow and are rejected. Approve `slack.com` in `CONNECTOR_ALLOWED_HOSTS` on API and worker. The token's workspace is checked with `auth.test`; direct messages and externally shared channels are excluded. Rotate/revoke the token in Slack and update the selected workspace secret as needed. This release does not implement installation OAuth or refresh-token rotation.

## Channel sync semantics

Each message and reply becomes a separate TXT knowledge source with channel/thread/author metadata and an official message link. Teams HTML is converted to plain text without active markup. Files and attachments are excluded. Each complete scan is bounded by `maxObjects` (1–1000 messages **including replies and deleted/empty records**), 100 pages per collection, 1 MB per text source and 10 MB aggregate snapshot. Slack uses 15-message pages to accommodate restricted app pagination; large or slow channels can exceed the five-minute sync deadline. Use this release for small, curated channels. It has no rolling date window, archive export, delta feed or provider retry/backoff service.

Snapshots are imported from the same bounded in-memory scan; unchanged content hashes skip ingestion. Edits update managed source revisions. Successfully completed inventories reconcile missing messages; incomplete/rejected/over-limit scans retain existing sources. Provider history may reflect retention or concurrent changes; there is no cross-request atomic provider snapshot. Imported content inherits knowledge-base access rather than mirroring channel membership. Choose an appropriately restricted knowledge base before importing. Pausing/disconnecting retains knowledge, and source workspace/channel identifiers cannot be edited after creation.

Teams/Slack tests use explicit provider-protocol fixtures; real account acceptance requires your app credentials, permissions and approved egress.
