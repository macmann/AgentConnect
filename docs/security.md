# Foundation security

Passwords use Node scrypt with per-user random salts and timing-safe comparisons. Sessions are opaque 256-bit random values stored as SHA-256 hashes. Cookies are HttpOnly, SameSite=Lax, Secure in production. Mutations require exact configured Origin, including for API clients. Login and password-reset requests are Redis-rate-limited. The API does not trust forwarded client IP headers by default.

Tenant authorization is enforced on the API server and in parameterized SQL ownership predicates. Composite foreign keys preserve workspace/organization ownership. Owner/org-admin privileges are organization-scoped; workspace roles cannot invite org admins. Role grants are explicit and deny unsupported capabilities. No production DB credentials should be exposed to clients.

Secrets and queued mail bodies are envelope encrypted using AES-256-GCM. The local master key is generated, never committed, and must be backed up securely. Loss means encrypted data cannot be recovered. APIs do not return secret values or ciphertext. Secret request logging is disabled. Never paste local .env or mail token values into logs or chat.

Verification is required before creating an organization or accepting invitations. Invitation tokens are email-bound and single-use. Reset revokes all sessions. Audit events record actor, IP, user-agent, tenant, resource, action and time without plaintext payloads.

Before production: KMS and key rotation, RLS/non-owner DB role, request-origin policy review for service clients, SMTP verification, per-account abuse controls, email enumeration/timing review, token/session retention, audit retention, penetration testing, TLS, SSO and backup restoration drills. Phase 0 is a development foundation.

Email action tokens are carried in URL fragments, removed by the client after loading and submitted in POST bodies. Fragments are not sent to the web server and therefore stay out of request URL logs.

## Phase 1 boundaries

Agent execution requires a tenant-scoped capability. Model credentials must reference a secret from the same workspace and organization. Immutable versions and deployments have composite foreign keys; stale draft edits/publishing return 409. Model requests permit approved destinations only and do not follow redirects. Private endpoints require explicit administrator configuration. The cloud outbound proxy adds another egress boundary.

Anonymous hosted conversation IDs alone grant no continuation access: a random bearer token is required, hashed in storage, and scoped to the deployment. Public metadata does not include prompts or credential references. Guest tokens and all chat output are rendered as text; generated HTML is not executed. Hosted chat has per-IP request limits; tenant spending quotas, moderation and bot protection remain later hardening work.

Conversation content is stored in PostgreSQL and readable by authorized workspace operators/builders. Production retention and privacy controls require the later operations phase. Provider error bodies are redacted. Only IDs, provider/model identity and reported usage are explicitly added to trace spans; review collector access and instrumentation before production.

## Phase 2 knowledge boundaries

Knowledge management/retrieval/read are distinct capabilities. Workspace owners/admins and builders manage knowledge; operators can inspect it; analysts can inspect and test retrieval; viewers have no knowledge access. Embedding configuration requires model-management capability. Every credential reference and knowledge attachment is scoped to the same workspace and organization.

Knowledge is internal by default. A published agent may use internal knowledge in authenticated playground, but public deployment creation requires explicit public access for all attached knowledge bases. Public retrieval checks that setting on every request. Retrieved passages and citation snippets may reveal source content; the UI states this when enabling public access.

Website crawling uses an independent exact-host allowlist, HTTPS, private-address rejection/DNS pinning on direct connections, robots rules, size/depth limits and no redirects. Private server exceptions are explicit and empty by default. No generated text or source HTML is executed by the browser. Source text is framed as untrusted context; this reduces prompt-injection exposure without proving model faithfulness. Reference checks verify source IDs, not factual entailment.

Deletion hides the source, removes vectors and cancels jobs immediately. Raw objects are purged through a durable tombstone after ten minutes; failures retry. Enterprise malware scanning, parser isolation, document ACL synchronization, retention policy, storage encryption/KMS and adversarial retrieval evaluation remain hardening work.

Phase 3 integration policy is documented in tools.md. Registry and connector changes require administrator capabilities; builders may test/attach reviewed tools. HTTP tools are GET only, PostgreSQL access uses fixed parameterized read queries and restricted roles, MCP tools require declared and administrator-reviewed read-only behavior. These are reviewed integration contracts, not a proof of upstream side-effect freedom. Anonymous tool output requires explicit public opt-in. Secrets and sensitive result keys are redacted from traces; appropriate business-data exposure and retention remain administrator responsibilities.

Workflow permissions are explicit: builders manage and execute, operators inspect and approve, analysts inspect, and viewers have no workflow access. Administrators retain all workflow capabilities. Approval decisions are tenant scoped and audited; published versions reject updates. Execution rechecks published agent availability and current tool/knowledge policies. Checkpoint and trace values contain tenant data; limit database access and establish retention before production. This slice exposes no anonymous workflow execution or mutating tools.

## Operations boundaries

Operations read, administration, review and member-management capabilities are distinct. Analysts can inspect conversations without reviewing or executing agents. Workspace role updates cannot alter organization memberships or the actor's own membership; workspace admins cannot grant/change workspace admins. API bearer authentication is accepted only for a matching, unexpired, unrevoked single-agent key on POST agent chat and still checks the issuer's live execution permissions. Tokens are hashed and never listed. Non-chat writes retain trusted-origin enforcement.

Webhook registration uses a separate exact-host HTTPS policy; delivery uses the SSRF-restricted provider transport with no private destination exception or redirect following. Secrets are encrypted, and outbound events contain run metadata only. Receivers must validate HMAC/timestamp and deduplicate event IDs. Review/correction text is exposed only through conversation-authorized routes and never copied into audit metadata. Deployment environment labels are not security isolation; hosted access policies still apply.
