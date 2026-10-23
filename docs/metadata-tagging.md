# Knowledge metadata tagging

Use metadata to organize knowledge and narrow the evidence an agent can retrieve. Tags and fields belong to a source and apply to all its chunks. This works for uploads, pasted text, Q&A, website sources and connector-managed sources.

## Choose a tagging method

| Method                 | Where                                                    | Behavior                                                                                                     |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Manual editing         | Sources → Tags & metadata                                | Replace that source's tags and custom fields; preserve internal ingestion/connector metadata.                |
| Shared upload metadata | Upload document → Shared metadata for all selected files | Copy the same values to one file or a batch of up to 100.                                                    |
| Bulk editing           | Select source checkboxes                                 | Preview additions, removals and field updates, then apply to up to 100 sources atomically.                   |
| AI suggestions         | Suggest metadata with AI                                 | Generate document-specific suggestions using a selected workspace model; review each source before applying. |

Example source metadata:

```json
{
  "tags": ["policy", "retail"],
  "attributes": {
    "department": "retail",
    "product": "loans",
    "language": "English",
    "document_type": "policy",
    "effective_date": "2026-01-01"
  }
}
```

## Tag individual sources

1. Open **Knowledge**, select a knowledge base and stay on **Sources**.
2. Expand **Tags & metadata** beneath a source.
3. Enter comma-separated tags. Use **Add metadata field** for each key/value pair.
4. Select **Save metadata**.

Changes affect current retrieval immediately. They do not change content revisions, re-embed documents or queue ingestion. If another editor changed the metadata, use **Reload metadata**, reconcile your edits and save again.

Q&A uses the same tags as its existing create/edit form and CSV import/export. Custom fields are edited through the metadata editor; they are not added to the Q&A CSV format.

## Set shared metadata during upload

1. Select **Upload document** and choose one file or up to 100 files.
2. Expand **Shared metadata for all selected files**.
3. Add common values, for example tag `policy` and field `department=retail`.
4. Optionally enable AI suggestions as described below.
5. Select **Start uploads**.

Each file captures the options when added to the queue. Changing the form later does not alter queued files. Retries retain the original options and upload identity. Keep Knowledge open until browser transfers finish; received files continue ingestion in the background. See [multi-file upload behavior](user-guide.md#upload-multiple-documents).

## Bulk-edit existing sources

1. Select the checkboxes next to the sources to update. The header checkbox selects up to 100 sources.
2. In **Bulk metadata editor**, enter tags to add and fields to set.
3. Use **Remove tags** or **Remove field keys** for explicit removals.
4. Select **Preview bulk changes** and inspect each source's before/after values.
5. Select **Apply to N sources**.

For example, adding tag `reviewed` and setting `department=retail` retains existing tags such as `policy` and fields such as `product=loans`. Setting a field replaces that field's value. A tag or field cannot be added/set and removed in the same request.

The batch commits all changes or none. A stale revision, unavailable source or exceeded metadata limit stops the entire batch. Reload and preview again; a preview is not a reservation or a partial save.

## Generate and review AI suggestions

AI tagging is **off by default**. It is separate from OCR and AI document extraction.

For new uploads, enable **Suggest metadata with AI** and select a registered workspace chat model before starting uploads. The same switch works when uploading one file. For existing sources, expand **AI metadata tagging**, or use **AI suggestions for selected sources** in the bulk editor, then enable the switch, select a model and generate suggestions.

The worker waits for ready indexed content, then sends a bounded excerpt to the selected provider. It normally makes one generation call per file and can incur provider cost. It uses a separate worker lane, so tagging does not hold up other ingestion jobs. An active request for a source is reused; reject pending suggestions before requesting a replacement.

When a source shows **Review AI metadata suggestions**:

1. Expand the review and inspect each proposed tag and field.
2. Uncheck values you do not want to apply.
3. Select **Apply reviewed suggestions**, or **Reject suggestions**.

Nothing is applied automatically. Selected tags are added; selected field values replace those fields; unrelated values remain. Review is per source, including files uploaded in a batch. Use the regular metadata editor for values the model did not suggest.

AI can miss details because it reads an excerpt, not necessarily the entire document. Source content or metadata changes invalidate approval of an old suggestion: reject it and generate again. AI tagging does not approve knowledge releases or give a source access permissions.

## Filter retrieval

In **Agent → Configure → Knowledge → Retrieval**, expand **Filter by tags & metadata**. The knowledge **Retrieval playground** exposes the same controls.

```json
{
  "query": "What is the refund policy?",
  "mode": "hybrid",
  "metadataFilter": {
    "tagsAll": ["policy", "retail"],
    "attributes": { "product": "loans" }
  }
}
```

Every required tag and field/value pair must match exactly. Matching is case-sensitive. Empty filters search all otherwise eligible sources. Dates are strings with exact matching; range operators, OR filters and nested metadata are not supported.

Filters combine with source IDs, public/private access and release restrictions before candidate limits, fusion and reranking. Approved-Q&A preference operates on the filtered evidence. No matching metadata means no matching passages; filters do not silently fall back to other sources.

Save an agent and start a new Playground chat to use updated configuration. Publish a new agent version to update published-agent execution. REST KB search and MCP `knowledge_search` accept per-request filters; agent invocation uses its saved published configuration. Metadata is an organization/filtering feature, not a substitute for permissions. See [API examples](platform-api.md#metadata-filtered-knowledge-search).

## Current sources and approved releases

New knowledge releases snapshot tags and fields alongside their chunks. Retagging a current source, including applying AI suggestions, never changes an existing release. Create and publish a new knowledge release to update approved metadata. Existing agent release pins still select their pinned snapshot.

Older releases without metadata snapshots are treated as untagged for filtering. They do not inherit mutable current-source tags. Connector updates preserve custom metadata on existing managed sources. If a deleted source is recreated as a new source, review and tag the new source separately.

## Limits

| Setting                                           | Limit                                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Files per upload queue / sources per bulk request | 100                                                                                          |
| File size                                         | 10 MB                                                                                        |
| Tags per source                                   | 20, each 1–50 characters                                                                     |
| Custom fields per source                          | 20                                                                                           |
| Field key                                         | 1–40 characters; lowercase ASCII letter first, then lowercase letters, digits or underscores |
| Field value                                       | Nonempty string, up to 200 characters                                                        |
| AI excerpt                                        | Up to 12 chunks, 24,000 characters and 6,000 tokens, reduced to fit model context            |
| AI output                                         | Selected model limit, capped at 8,192 tokens                                                 |
| Generation deadline                               | 45 seconds                                                                                   |
| Interrupted worker attempts                       | At most 3                                                                                    |

Bulk edits and AI approval must still fit the per-source limits after merging. Uncheck some AI values or remove existing values explicitly if the merged result would exceed a limit.

## Troubleshooting

| Symptom                                 | Action                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Tagging is queued                       | Check that ingestion is Ready and the worker is running. Failed ingestion must be corrected first.       |
| No model available                      | Register an active chat model in the same workspace, with usable credentials and an approved endpoint.   |
| `MODEL_UNAVAILABLE`                     | Select an active model and request suggestions again.                                                    |
| `INVALID_SUGGESTION`                    | The response was not valid metadata JSON. Try another suitable model or retry generation.                |
| `INSUFFICIENT_CONTEXT`                  | Choose a model with enough context/output capacity.                                                      |
| `SOURCE_CHANGED` / `SOURCE_UNAVAILABLE` | Check source status; generate again after ingestion completes.                                           |
| `PERMISSION_REVOKED`                    | A currently authorized workspace user must request generation again.                                     |
| Provider failure / `TAGGING_FAILED`     | Check the model connection and safe error code; submit a new request after resolving the cause.          |
| `WORKER_INTERRUPTED`                    | Expired leases recover automatically up to the attempt limit; request again after recovery if exhausted. |
| Bulk edit or approval returns 409       | Reload current metadata, review again, or reject and regenerate a stale AI proposal.                     |
| Search is empty                         | Check exact spelling/case, all filter conditions, source readiness and the selected knowledge release.   |

Explicit provider/format failures are not retried indefinitely. Reported usage is available in suggestion-job responses; generation uses existing tracing when configured. Arbitrary provider error text is not stored.

## Upgrade and operation

```sh
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm db:migrate
```

Migration **0039** adds metadata indexes; **0040** adds durable AI tagging jobs. Restart both API and worker after upgrading (or restart `pnpm dev` locally). Production installations must rebuild/deploy the updated release images. The worker's `metadata_tagging` progress task is included in existing health monitoring.

No new environment key is required. AI uses the selected registered model's workspace credential and the existing model host/network configuration on the worker. Enabling the switch authorizes sending the sampled text to that provider. Turning it off for a later upload does not cancel previously queued requests. Source deletion removes tagging jobs and proposals.

For operator checks, use the [deployment guide](deployment.md) and [recorded validation](validation.md#knowledge-metadata-tagging-validation).
