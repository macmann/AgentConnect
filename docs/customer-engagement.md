# Customer engagement and messaging

This release implements backlog items 1–4 and 6. Benchmarking (item 5) remains deferred. It adds migration **0028**; run `pnpm db:migrate`, then restart API, web and worker. Existing agent configurations and published versions keep their behavior until new options are saved and published.

## Customer satisfaction and outcomes

Hosted chat and the website widget have a **Rate this conversation** control after an answer. Customers can provide satisfaction (1–5), resolution (yes/no/not sure) and optional comments; they can update their response when they learn more. Access requires the conversation's customer session or guest token and, for widgets, the original approved origin.

Operations → Customer insights reports customer response counts, average CSAT, confirmed resolution and confirmed AI resolution, and includes feedback in Excel export. Staff conversation reviews do not become customer CSAT. An AI-resolved count requires explicit customer confirmation and no human support case; a chat without handoff is not assumed resolved. Feedback reporting uses the latest feedback update in the selected UTC date range. This is self-reported resolution, not verification of a completed banking transaction.

## Workflows inside conversations

Publish a workflow in Workflows. In Agent → Configure → Experience → Quick actions, choose **Run published workflow**, select its published version and optionally define customer input fields. The input node receives a JSON string containing `request` (the configured action message) and named field values. Existing workflow nodes can parse that input or use their existing input argument mappings. Save and publish the agent and promote the deployment to that version.

Clicking a workflow action can start a new conversation without an AI greeting. The customer sees input validation, execution status, completed step labels and the final output; history restores unfinished and completed runs. Refresh/retry uses a request ID to prevent duplicate launches. Changed inputs require a new request ID. Multiple actions share the conversation's single saved agent configuration, not a new workflow engine.

Only published workflow versions from the same workspace can be used. Every nested agent, knowledge base and tool is checked for public access when deploying and again at execution. Tools remain read-only. Staff approval nodes remain staff approval nodes: the customer sees “Waiting for staff approval” and cannot approve themselves. The existing worker runs these jobs. Customer workflow attribution is the conversation, with no fabricated staff user. Workflow records follow the existing workflow-run retention policy; active customer workflows protect their conversation from cleanup.

## Rich widget responses

The widget now renders the same supported text, cards, alerts, KPIs, tables, six chart types, confirmed data-collection forms/actions and TXT/Markdown/CSV downloads as hosted chat. Chart data is accessible as a table. Content uses fixed DOM/SVG renderers and text nodes; model HTML is not executed. Downloads use short-lived, scoped artifact grants. Form submission obeys the published agent's public-form capability and is still validated by the server. Existing saved responses restore rich blocks after refresh.

## Semantic knowledge-gap review

Operations → Knowledge gaps → **Group related questions by meaning** uses a selected workspace embedding model. It sends at most the latest 300 affected questions (up to 2,000 characters each) in the report range to that provider. Similarity defaults to 0.85; complete-link grouping avoids loosely related chains. Unclustered questions retain normalized exact grouping. The screen states when the report or clustering is truncated.

Original questions, conversation/run IDs, staff corrections and customer feedback remain attached to their topics. Reviewers can merge topics or split individual examples; explicit reviewer assignments take precedence over future automatic grouping. Priority combines frequency, customer dissatisfaction/unresolved feedback and human handoff. Review suggestions are prompts to check approved content, not invented answers.

The existing independent review → knowledge draft → approved source → reviewed release process remains authoritative. Topics show linked correction state and, once a release actually includes the correction, occurrences before and after first publication within the report window and whether the current release still contains it. Time spans may differ; these counts are observational and do not prove an improvement caused a trend.

## Customer messaging setup

These adapters are separate from the existing Slack/Teams **knowledge ingestion** connectors. Customer messaging supports **Messenger, Viber, Telegram and Microsoft Teams**, in private/direct conversations. Group/channel messages are ignored. No WhatsApp or additional CRM connectors are added.

The installation administrator must expose the API through public HTTPS and set:

```dotenv
MESSAGING_PUBLIC_URL=https://api.example.com
```

Use the API origin, without a path, query or credentials. The reverse proxy must forward `/messaging/webhooks/*` unchanged, including raw body and signature headers. Restart the API. This installation setting is shared by all customers; customers then choose a published deployment, add the channel credentials under **Channels → Customer messaging**, and select **Connect / test credentials**.

| Channel   | Credentials                                                          | What Connect does                                                                   | Provider setup still required                                                                                                                            |
| --------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram  | BotFather token                                                      | Calls `getMe`, registers the callback and a random webhook secret with `setWebhook` | Create the bot; open its private chat and start messaging                                                                                                |
| Viber     | Approved bot authentication token                                    | Calls `get_account_info`, registers the callback with `set_webhook`                 | Viber bot approval and applicable provider fees                                                                                                          |
| Messenger | Page access token and Meta app secret                                | Verifies Page identity and subscribes its app to messages                           | Enter generated callback and verify token in Meta Messenger webhook settings; Page/app permissions and production app review                             |
| Teams     | Azure Bot app ID and client secret; tenant ID for single-tenant bots | Verifies client credentials for the Bot Framework scope                             | Set Azure Bot Messaging endpoint to the generated callback, enable Teams channel, install an app with the bot ID and personal scope; tenant app approval |

Messenger and Teams display **Credentials verified — complete provider setup** until a valid signed event arrives. Telegram and Viber register their callback automatically. Send a real message from a customer account as the final setup test, then inspect **Delivery status**. Production provider permissions cannot be bypassed by the product. The UI does not claim production approval from a credential test.

Credentials are encrypted using the existing master key; API responses never return them. Edit can replace credentials; blank fields preserve saved values. Saving disconnects the channel until it is tested again. Disconnect stops processing and delivery locally; provider callback settings remain configured and disabled callbacks are acknowledged without queueing messages.

Messages are authenticated using Meta/Viber HMAC signatures, Telegram's webhook secret, and Teams RS256 Bot Framework tokens (issuer, app audience, expiration, tenant and authenticated service URL checks). Fixed provider hosts and guarded Teams service hosts prevent credentials being sent to customer-supplied arbitrary endpoints.

Incoming events are persisted before acknowledgement and deduplicated by provider event ID. Replies reuse the same agent runtime, conversation history, RAG/tool policies, routing/failover and model diagnostics. The API's durable messaging loop runs alongside the API server; the existing workflow worker handles workflows. HTTP 429/5xx and network delivery failures use bounded backoff (up to five attempts); a saved AI reply is reused rather than regenerated. Successfully delivered chunks have a persisted cursor. An ambiguous provider timeout can still duplicate the current chunk: these providers do not all offer an idempotent outbound-send API. An interrupted AI job is marked failed rather than automatically replayed.

Customers can send `/help`, `/support`, `/rating 1` through `/rating 5`, and `/resolved yes` or `/resolved no`. `/support` uses the published human-entry policy and customer consent flow. Messages during a human session go to the existing support inbox; public operator replies are sent back through the same channel. Private notes are never sent. Rich responses use safe text on messaging services; the hosted chat and widget retain interactive rich rendering.

## Validation and operational limits

Automated tests exercise protocol fixtures, signature/JWT validation, scopes, duplicates, controlled retries, workflow execution, browser persistence and rich controls. They do not send live messages to external customers or validate a provider's production approval. Real channel tokens and public callbacks are needed for the final provider acceptance test. Configure outbound networking for the provider domains in a restricted production network; the existing model host setting is unrelated to channel domains.
