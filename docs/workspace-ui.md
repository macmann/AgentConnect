# Workspace UI enhancement

The workspace pages now apply the Agent Configure pattern of focused tasks and progressive disclosure. Existing APIs, storage, permission rules and optimistic revision checks remain authoritative.

| Page       | Focused sections or groups                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| Tools      | Registered tools, Tool setup, MCP connectors, Execution history                                                |
| Knowledge  | Knowledge bases and Embedding models; existing source, retrieval playground and settings views remain          |
| Quality    | Datasets, Evaluation, Publication gates, Evaluation history                                                    |
| Channels   | Website widgets and Support requests                                                                           |
| Retention  | Retention policy, Preview & cleanup, Cleanup history                                                           |
| Operations | Consistent responsive navigation for analytics, pricing, access keys, webhooks, members, deployments and audit |
| Models     | Connection details first; model limits and sampling capabilities behind an expandable group                    |
| Connectors | Scan limits and schedules behind an expandable advanced group                                                  |

Section navigation uses the existing hash route with page-specific keys: `toolsSection`, `knowledgeSection`, `qualitySection`, `channelsSection`, `retentionSection` and `operationsSection`. Direct links, refresh and browser history preserve the selected section. Global organization/workspace/view routing remains unchanged. On mobile the section navigation becomes a labeled dropdown.

Existing forms remain mounted while switching sections so edits are retained. Tool edits open Tool setup; a successful tool save returns to the registry. Evaluation runs open Evaluation history. Empty states explain prerequisites and provide relevant actions, subject to the user's existing role.

Retention has a sticky Save/Discard bar with a dirty indicator based on actual differences from the saved policy. Unsaved policies block cleanup previews and trigger a leave warning. Cleanup still requires a saved policy and explicit confirmation; switching sections does not discard policy edits. Tool setup, model registration and widget settings also provide sticky save controls.

No database migration, dependency or permanent environment change is required. Support and workflow navigation keep their existing task structure. Deployment automation and monitoring remain deferred.

Screenshots: [Tools on desktop](workspace-ui/tools-desktop.png) and [Retention on mobile](workspace-ui/retention-mobile.png). The mobile capture shows a focused field kept above the sticky save controls.
