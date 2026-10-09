# Phase 6: generative experience initial release

Agents can return a versioned, declarative response containing text, cards, alerts, KPIs, tables, charts, forms, action buttons and downloadable files. The API validates the complete response before rendering it through trusted React components. This is an initial Phase 6 slice, with the remaining scope listed below.

## Upgrade and try it

Apply migration 0008 with `pnpm db:migrate`, then restart API, worker and web. Existing agent configurations remain compatible and default to generative responses disabled. This branch includes the Phase 5 operations migration and depends on that release.

1. Open **Agents**, select or create an agent, and enable **Generative responses** under Configure. Choose the allowed response components. At least one must remain selected.
2. Select a real model that follows JSON schema instructions. Configure its actual context and output limits in Models, and an adequate output budget in the agent. The component schema adds to the system prompt and consumes context. A model's registered limits still constrain the agent; the application does not claim a provider supports a configured limit.
3. Save the draft, start a new playground chat and ask: “Show a revenue chart for January 10 and February 20, include a table, create a contact form with an email field, and offer the data as CSV.” The model chooses the blocks; those exact results are not guaranteed.
4. Fill the form and click its submit button. Confirm the dialog to store the values. Cancelling does not submit. Open **Collected data**, expand the record, search its values, or export the currently loaded records as JSON.
5. Download the generated file. Publish the saved draft and create a hosted deployment to try the same rendering publicly. Public form/action submission is disabled by default; explicitly enable it and publish a new version to allow collection. Existing conversations keep their original configuration snapshot.

Forms collect values into workspace records. They do not automatically update knowledge, call attached tools, send email or resume workflows. Collected data requires `operations:view`; organization owners/admins, operators and analysts can read it under the current role rules. Form submission belongs to the private conversation owner or the matching public conversation token. Historical conversation views render the saved components and permit authorized downloads, with submission controls disabled.

## Response protocol and actions

`GET /ui/components` provides the authenticated version-1 component registry and the built-in `data.collect` action. The model returns a JSON object with `version: 1`, a plain-text `message`, and `blocks`. The canonical schemas are in `packages/schemas/src/generative.ts`. Unknown component types, extra properties, unknown actions, duplicate identifiers/fields/columns and disallowed component types are rejected. Plain-text content is escaped by React; no model-provided JavaScript or HTML executes.

Generative chat buffers provider output rather than displaying partial JSON. The saved assistant message includes validated `ui_blocks`. An SSE `ui` event returns its `messageId`, plain-text `message`, rendered `blocks` and `actionsEnabled`, followed by the existing terminal event. Clients must still read the terminal SSE event: HTTP 200 alone does not mean the provider succeeded. Malformed responses produce `INVALID_UI_RESPONSE`, never render raw JSON, and are not stored as successful assistant replies. Existing cancellation, run accounting, RAG citation validation and operation events remain in the chat path. Conversation model history uses the textual summary, without replaying submitted field values or downloaded file contents.

Forms allow text, email, number, textarea, select, checkbox and date fields. `POST /messages/{messageId}/actions/{blockId}` requires `confirmed: true` and validated `values`. The API resolves the persisted block and checks conversation access, current deployment availability and the saved public-collection setting. Action buttons use their persisted values; clients cannot replace them. Each block accepts one submission; replay returns 409. A new form response has a new message ID. API keys currently authorize chat execution only and cannot grant file downloads or submit generated forms.

## Files and limits

TXT, Markdown and CSV are stored as private objects with tenant-scoped metadata. File contents are removed from the UI event; it receives an artifact ID. An authorized grant request returns an application download URL signed with a domain-separated HMAC and valid for five minutes. The signed URL itself is a temporary capability: anyone holding it can download until expiry, including after access is revoked during that interval. Rotating `MASTER_KEY` invalidates these URLs and also requires handling the existing encrypted-secret migration requirements.

Downloads use sanitized filenames, attachment disposition and fixed content types. CSV cells are quoted and leading spreadsheet formula characters are neutralized. There is no arbitrary remote URL download or model-controlled object-store path. Failed output preparation or database persistence attempts to clean up uploaded objects. Production retention, deletion policies and orphan-object reconciliation remain deployment work.

Responses allow at most 12 blocks, three files and 500 KB per file. The existing 256,000-character chat response cap also applies. Text files allow 40,000 characters; tables/CSV have at most 12 columns and 100 rows. Forms have at most 12 fields. Charts accept up to 30 nonnegative values. SVG charts cover bar, line, area, pie, donut and scatter; this initial chart schema is a single categorical series, with scatter using sequence position rather than independent numeric x coordinates. A data table is available for accessibility.

## Remaining Phase 6 scope

This release supports agent playground and hosted chat, not rich UI workflow-node output. PDF, DOCX, XLSX, editable component registries, arbitrary/custom action integrations, generic approval routing, multi-series/XY charts and automated collected-data destinations remain later extensions. Existing workflow human-approval nodes are separate from generated form confirmation. Voice and enterprise connectors remain subsequent planned phases.

## Validation

Backend integration tests exercise schema rejection, persistence, real local object storage, file authorization/signature expiry, CSV safety, tenant/role boundaries, confirmation, form validation, replay rejection and public tokens/deployment disablement. The browser scenario exercises real SSE through an explicitly approved local protocol fixture, component rendering, cancelled/accepted confirmation, a download, collection search, public defaults and mobile overflow. These tests do not establish live DeepSeek or other provider acceptance. See `docs/validation.md` for checks executed.
