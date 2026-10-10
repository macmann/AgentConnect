# MASTER BUILD SPECIFICATION

## Next-Generation Enterprise AI Agent & Multi-Agent Platform

Build a production-grade, multi-tenant enterprise AI platform that provides the same broad product capabilities as Atenxion while using a modern architecture and improving extensibility, observability, security, agent orchestration, RAG, integrations, generative UI, and developer experience.

This is a greenfield implementation.

Do NOT attempt to copy source code or internal implementation details from any existing product.

Reproduce and improve the product capabilities described in this specification.

The platform should allow non-technical and technical users to:

- build AI agents
- connect enterprise knowledge
- connect structured databases
- configure LLMs
- create multi-agent workflows visually
- attach tools
- integrate APIs
- integrate MCP servers
- build RAG pipelines
- deploy agents
- embed agents in websites
- expose agents through channels
- collect user information
- run real-time voice agents
- monitor conversations
- evaluate responses
- manage guardrails
- analyze usage
- control permissions
- generate files and charts
- dynamically generate application UI
- execute long-running agent workflows
- support human approval
- operate in cloud or self-hosted environments

The architecture must be modular enough that individual capabilities can later become standalone services.

---

# 1. PRODUCT PRINCIPLES

Design around these principles.

## 1.1 Enterprise first

Support:

- organizations
- workspaces
- teams
- RBAC
- audit logs
- SSO-ready architecture
- API keys
- encrypted secrets
- private deployment
- configurable model providers
- tenant isolation
- usage tracking
- data retention policies

Never assume a single-user SaaS application.

---

# 1.2 Provider neutral

Never make OpenAI or any other provider a hard dependency.

Implement provider abstractions for:

- chat models
- reasoning models
- multimodal models
- embeddings
- rerankers
- speech-to-text
- text-to-speech
- real-time audio
- image models

Initial providers should include adapters for:

- OpenAI
- Azure OpenAI
- Anthropic
- Google Gemini
- AWS Bedrock
- OpenAI-compatible endpoints
- Ollama
- vLLM
- custom HTTP providers

Provider credentials belong to organizations/workspaces and must be encrypted.

---

# 1.3 Agent-runtime independent architecture

Business objects such as:

Agent
Workflow
Tool
KnowledgeBase
Conversation
ModelConfiguration

must not depend directly on LangGraph.

Create internal domain interfaces.

LangGraph may be the initial orchestration runtime, but the application must theoretically allow another runtime later.

---

# 1.4 Schema-driven system

Use strongly typed schemas for:

- agent configuration
- workflow definitions
- tool definitions
- UI definitions
- model configuration
- guardrails
- connector configuration
- deployment settings

Use Zod/JSON Schema where appropriate.

Store versioned configuration.

---

# 1.5 Everything versioned

Agents, prompts, workflows and deployments must have version history.

Users must be able to:

- edit draft
- save
- publish
- rollback
- compare versions

A production deployment must reference an immutable published version.

---

# 2. RECOMMENDED TECH STACK

Use current stable mutually-compatible releases when implementation starts.

Do not blindly pin versions from this specification if newer compatible stable versions exist.

## Monorepo

Use:

- pnpm
- Turborepo
- TypeScript
- strict TypeScript configuration

Suggested structure:

```text
/apps
  /web
  /api
  /agent-runtime
  /worker
  /ingestion
  /widget

/packages
  /db
  /auth
  /ui
  /schemas
  /agent-sdk
  /tool-sdk
  /provider-sdk
  /mcp
  /rag
  /observability
  /security
  /shared
  /config
```

---

# 3. FRONTEND

Use:

- Next.js App Router
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- Radix primitives where needed
- TanStack Query
- TanStack Table
- React Hook Form
- Zod
- Zustand only for truly client-global transient state
- @xyflow/react for workflow/canvas editing
- Monaco Editor for advanced JSON/code editing
- Recharts or Apache ECharts for analytics
- SSE/WebSocket streaming for runtime events

Prefer Server Components where useful.

Do not make everything client-side.

---

# 4. BACKEND/API

Create a standalone API application.

Recommended:

- Node.js
- TypeScript
- Fastify

Alternative:

- NestJS with Fastify adapter

Expose:

- REST APIs for CRUD
- OpenAPI specification
- SSE for token/event streaming
- WebSocket where true bidirectional low-latency communication is necessary

Do not mix all business logic into Next.js route handlers.

Next.js may contain BFF-style endpoints where appropriate but core APIs belong in the backend service.

---

# 5. DATABASE

Use:

PostgreSQL

with:

pgvector

Use pgvector >= 0.8.7.

Use:

- Drizzle ORM or Prisma
- explicit migrations
- UUID/UUIDv7 identifiers
- JSONB where flexible configuration is appropriate

Do not store everything as JSON.

Important entities must have proper relational schemas.

---

# 6. CACHE / TRANSIENT STATE

Use Redis-compatible infrastructure for:

- distributed locks
- caching
- rate limiting
- ephemeral presence
- streaming coordination
- short-lived agent state where appropriate

Do not make Redis the authoritative persistent database.

---

# 7. DURABLE EXECUTION

Use Temporal for durable asynchronous operations.

Use it for:

- document ingestion
- site crawling
- connector synchronization
- large file processing
- workflow execution requiring durability
- retryable integrations
- long-running agent tasks
- scheduled jobs
- background evaluation
- data export
- webhook retries
- resumable processes

Agent execution itself may use LangGraph.

Architect integration as:

```text
Request
   ↓
Agent Runtime
   ↓
LangGraph
   ↓
Tool invocation
   ↓
Temporal workflow/activity where durability is required
```

Do not make every trivial agent interaction a Temporal workflow.

---

# 8. AGENT ORCHESTRATION

Use LangGraph as the initial graph execution engine.

Support:

- stateful graphs
- deterministic nodes
- LLM nodes
- tools
- conditional routing
- loops
- subgraphs
- human approval
- interrupts
- persistent checkpoints
- retries
- streaming
- parallel branches
- failure handling

Wrap LangGraph behind internal interfaces.

---

# 9. OBSERVABILITY

Use OpenTelemetry.

Capture:

- HTTP traces
- DB spans
- agent runs
- LLM calls
- tool calls
- retrieval operations
- workflow nodes
- Temporal executions
- errors
- latency
- token usage
- provider costs

Every AI execution should have:

```text
trace_id
run_id
conversation_id
agent_id
agent_version
workflow_id
workflow_version
organization_id
workspace_id
user_id
```

where applicable.

Allow an external observability system such as Langfuse, LangSmith, Phoenix, Grafana/Tempo or compatible OTLP platforms to be attached without redesigning the application.

---

# 10. AUTHENTICATION

Implement:

- email/password
- password reset
- email verification
- OAuth-ready architecture
- Google login
- Microsoft login

Prepare interfaces for enterprise:

- OIDC
- SAML
- SCIM

Use secure session handling.

---

# 11. MULTI-TENANCY

Hierarchy:

```text
Platform
  ↓
Organization
  ↓
Workspace
  ↓
Projects / Agents / Knowledge / Workflows
```

Every tenant-owned DB entity must contain appropriate tenant ownership.

Never rely only on frontend filtering.

Enforce tenant isolation at API/service/database boundaries.

Consider PostgreSQL Row Level Security for sensitive tenant tables.

---

# 12. ORGANIZATION MANAGEMENT

Organizations support:

- organization name
- branding
- owner
- members
- billing configuration
- default model settings
- default security policy
- storage quotas
- token quotas
- API quotas

---

# 13. WORKSPACES

Organizations may contain multiple workspaces.

Workspace functionality:

- members
- roles
- agents
- workflows
- knowledge bases
- integrations
- secrets
- models
- environments
- deployments
- analytics

---

# 14. RBAC

Initial roles:

### Organization Owner

Full organization control.

### Organization Admin

Administrative control except ownership transfer.

### Workspace Admin

Manage workspace resources.

### Builder

Create/edit agents, workflows and knowledge.

### Operator

Monitor conversations, executions and feedback.

### Analyst

Analytics and read-only operational access.

### Viewer

Read-only access.

Allow future custom roles.

Permission model should use explicit capabilities such as:

```text
agent:create
agent:update
agent:publish
agent:delete

workflow:create
workflow:update
workflow:execute

knowledge:create
knowledge:update

conversation:view
conversation:modify

member:invite

secret:manage
```

---

# 15. AUDIT LOGGING

Audit:

- login
- logout
- member changes
- role changes
- secret changes
- agent changes
- workflow changes
- publication
- deployment
- API key creation/revocation
- knowledge deletion
- conversation modification
- security changes

Record:

- actor
- action
- entity
- before/after metadata where safe
- timestamp
- IP
- user agent

Never log secret plaintext.

---

# 16. AI MODEL REGISTRY

Create a Model Registry.

Model types:

- chat
- reasoning
- multimodal
- embedding
- reranker
- speech recognition
- speech synthesis
- real-time audio
- image generation

Each registered model contains:

- provider
- model identifier
- display name
- capabilities
- context window
- max output tokens
- pricing metadata
- availability
- default parameters
- workspace accessibility

---

# 17. CUSTOM MODEL PROVIDERS

Allow users to configure custom OpenAI-compatible providers.

Fields:

- provider name
- base URL
- API key
- model ID
- context size
- supported modalities
- capabilities

Enable connectivity test.

---

# 18. AGENT STUDIO

Primary object:

Agent

Support agent categories:

### Unstructured Agent

Designed primarily around RAG and document/media knowledge.

### Structured Agent

Designed around structured data, SQL and datasets.

### Hybrid Agent

Can combine:

- RAG
- structured data
- APIs
- tools
- multimodal input

Internally these should use the same extensible agent model rather than three completely different code paths.

---

# 19. CREATE AGENT

Wizard:

```text
Create Agent
    ↓
Choose Template / Blank
    ↓
Name + Description
    ↓
Select Model
    ↓
Define Instructions
    ↓
Attach Knowledge
    ↓
Attach Tools
    ↓
Configure UX
    ↓
Test
    ↓
Publish
```

---

# 20. AGENT BASIC SETTINGS

Fields:

- name
- internal description
- public description
- avatar
- system instructions
- model
- temperature
- top-p where supported
- max output tokens
- language
- timezone
- welcome message
- conversation starters
- fallback response
- conversation history window
- memory configuration

---

# 21. PROMPT MANAGEMENT

Provide structured prompting sections:

- role
- objective
- instructions
- constraints
- tone
- output format
- escalation policy

Also provide Advanced Mode containing full system prompt.

Support template variables.

Example:

```text
{{user.name}}
{{user.email}}
{{workspace.name}}
{{current_date}}
{{conversation.language}}
```

---

# 22. AGENT MEMORY

Support:

### Conversation memory

Current conversation state.

### User memory

Persisted user facts with policy controls.

### Workspace memory

Optional shared context.

Memory configuration:

- enabled/disabled
- retention
- extraction policy
- maximum memories
- user visibility
- delete memory
- consent requirements

Do not implicitly persist sensitive user information.

---

# 23. KNOWLEDGE BASE SYSTEM

KnowledgeBase entity.

Knowledge sources:

- files
- websites
- manual text
- Q&A
- cloud drives
- databases
- APIs
- connector resources

---

# 24. DOCUMENT INGESTION

Support:

- PDF
- DOCX
- PPTX
- XLSX
- CSV
- TXT
- Markdown
- HTML
- JSON

Architecture should allow new parsers to be registered.

Extract:

- text
- headings
- page numbers
- document metadata
- tables
- links
- document structure

Preserve source provenance.

---

# 25. MULTIMODAL INGESTION

Support:

- PNG
- JPG
- JPEG
- WEBP
- audio
- video

Optional extraction pipelines:

Images:

```text
OCR
vision analysis
metadata
```

Audio/video:

```text
audio extraction
speech-to-text
timestamps
metadata
```

---

# 26. WEBSITE INGESTION

Modes:

### Single page

Ingest one URL.

### Recursive crawl

Configurable:

- domain
- allowed paths
- blocked paths
- crawl depth
- page limit
- refresh schedule

Respect robots/security configuration where appropriate.

Store canonical source URL for every retrieved chunk.

---

# 27. CLOUD SOURCES

Connector architecture must support:

- Google Drive
- Microsoft OneDrive
- SharePoint
- Amazon S3

Later support:

- Dropbox
- Box
- Confluence
- Notion

Each connector supports:

- OAuth/API credentials
- folder selection
- sync
- incremental sync where possible
- sync status
- sync errors
- manual refresh
- scheduled refresh

---

# 28. MANUAL Q&A

Users can create:

Question
Answer
Tags

Allow:

- CRUD
- CSV import
- CSV export
- bulk editing

Treat curated Q&A as high-priority knowledge.

---

# 29. RAG PIPELINE

Implement configurable RAG.

Pipeline:

```text
Input
 ↓
Query understanding
 ↓
Query rewriting optional
 ↓
Retrieval
 ↓
Hybrid search optional
 ↓
Filtering
 ↓
Reranking
 ↓
Context assembly
 ↓
LLM
 ↓
Citation generation
```

---

# 30. CHUNKING

Support configurable strategies:

- fixed token
- recursive text
- markdown-aware
- semantic
- page-aware
- heading-aware

Configuration:

- chunk size
- overlap
- metadata preservation

---

# 31. EMBEDDINGS

User selects embedding model.

Allow:

- hosted providers
- local embeddings
- custom embeddings

Embedding dimensions must be tracked per collection.

Prevent incompatible embeddings from being mixed.

---

# 32. VECTOR SEARCH

Initial backend:

PostgreSQL + pgvector.

Support:

- cosine
- inner product
- L2
- HNSW

Abstract vector search behind an interface to allow future:

- Qdrant
- Milvus
- Pinecone
- Weaviate
- Elasticsearch/OpenSearch

without modifying agent logic.

---

# 33. HYBRID SEARCH

Support:

```text
Vector semantic search
+
PostgreSQL full-text search
```

Combine results through configurable fusion.

---

# 34. RERANKING

Support optional reranking.

Provider abstraction.

Configuration:

- model
- retrieved candidate count
- final top-K
- score threshold

---

# 35. RAG CITATIONS

Every retrieved chunk keeps:

- document
- page
- source URL
- title
- chunk ID
- relevance score

Agent responses can emit references.

Frontend allows user to inspect cited material.

---

# 36. KNOWLEDGE PLAYGROUND

Allow builders to test retrieval independently from the agent.

Input query.

Display:

- original query
- rewritten query
- retrieved chunks
- scores
- reranked scores
- metadata
- latency
- token estimate

This is essential for debugging RAG.

---

# 37. TOOL REGISTRY

Create a generic Tool interface.

Every tool should expose:

```text
id
name
description
inputSchema
outputSchema
permissions
executionType
timeout
retryPolicy
```

Tools can be attached to agents or workflow nodes.

---

# 38. BUILT-IN TOOL: RAG

Search specified knowledge bases.

Configuration:

- KB selection
- retrieval profile
- top-K
- filter
- reranking

---

# 39. BUILT-IN TOOL: WEB SEARCH

Provider-neutral search abstraction.

Configuration:

- provider
- result count
- domain allow list
- domain deny list
- recency
- safe-search policy

---

# 40. BUILT-IN TOOL: HTTP/API

HTTP tool.

Support:

- GET
- POST
- PUT
- PATCH
- DELETE

Configuration:

- URL
- path variables
- query parameters
- headers
- auth
- JSON body
- timeout
- retry
- response extraction

Authentication:

- none
- API key
- bearer token
- basic
- OAuth connector
- secret reference

Never store secrets directly inside workflow JSON.

---

# 41. API TOOL TESTER

Builder interface:

- configure request
- supply test parameters
- execute
- inspect HTTP status
- headers
- JSON
- latency
- parsed tool result

---

# 42. DATABASE TOOL

Initial databases:

- PostgreSQL
- MySQL
- SQL Server

Later:

- Oracle
- Snowflake
- BigQuery

Support:

- schema discovery
- allowed tables
- allowed views
- read-only mode
- query timeout
- result row limit

Default AI database access must be READ ONLY.

Never allow unrestricted generated SQL against production databases by default.

---

# 43. SQL SAFETY

Before query execution:

- parse SQL
- block prohibited commands
- verify table permissions
- impose limit
- enforce timeout
- optionally require approval

Record executed query in traces.

---

# 44. CODE EXECUTION TOOL

Run generated code inside an isolated sandbox.

Initial language:

- Python

Potential later:

- JavaScript

Never execute arbitrary generated code directly in application containers.

Require:

- isolated runtime
- CPU limit
- memory limit
- execution timeout
- filesystem limit
- no network by default
- explicit network allowlist

---

# 45. MCP SUPPORT

MCP is a first-class subsystem.

Support current MCP specification.

Allow connecting remote MCP servers.

Transport support should follow current MCP SDK recommendations.

MCP connector management:

- server name
- URL
- authentication
- headers/secrets
- enabled/disabled
- available tools
- resources
- prompts
- capability metadata

Functions:

- connect
- test
- discover capabilities
- refresh capabilities
- enable selected tools
- tool execution

Cache MCP capability listings when supported.

---

# 46. CUSTOM MCP TEMPLATES

Admins can create reusable MCP connector templates.

Example:

```text
GitHub MCP
CRM MCP
Internal ERP MCP
HR MCP
```

Users then provide only required connection values.

---

# 47. CONTEXT-AWARE TOOL

Allow external application context to be passed securely to agents.

Examples:

```text
user ID
customer ID
current page
current account
selected invoice
tenant
locale
```

Context values must have schemas and explicit visibility policies.

---

# 48. FILE GENERATOR

Agent can produce:

- PDF
- DOCX
- XLSX
- PPTX
- CSV
- TXT
- Markdown

Implement this as a controlled artifact generation service.

Store generated files in object storage.

Return signed download URLs.

---

# 49. CHART GENERATOR

Agent returns structured chart schema rather than arbitrary JavaScript.

Types:

- line
- area
- bar
- stacked bar
- pie
- donut
- scatter
- KPI
- table

Example conceptual output:

```json
{
  "type": "bar",
  "title": "Revenue by Month",
  "xField": "month",
  "yField": "revenue",
  "data": []
}
```

Frontend safely renders the chart.

---

# 50. GENERATIVE UI

This is a major improvement over the existing product.

Agents should be capable of returning interactive user interfaces.

Do NOT allow arbitrary generated React/HTML to execute.

Use a controlled component catalog.

Examples:

- Card
- KPI
- Alert
- Table
- Chart
- Form
- TextInput
- NumberInput
- Select
- Checkbox
- DatePicker
- Button
- ApprovalCard
- Timeline
- Stepper
- List
- FilePreview

Agent emits declarative UI schema.

Renderer maps schema to trusted components.

Design it to be compatible in philosophy with A2UI.

Example:

```json
{
  "type": "form",
  "title": "Create Customer",
  "fields": [
    {
      "type": "text",
      "name": "name",
      "label": "Customer Name",
      "required": true
    },
    {
      "type": "email",
      "name": "email",
      "label": "Email"
    }
  ],
  "actions": [
    {
      "type": "submit",
      "label": "Create Customer",
      "action": "customer.create"
    }
  ]
}
```

Validate all UI schemas server-side.

---

# 51. UI ACTION SECURITY

A rendered button cannot invoke arbitrary backend code.

Actions reference registered tools/actions.

Example:

```text
action = customer.create
```

Runtime resolves the action through permission-controlled registry.

Support confirmation policies:

```text
none
confirm
human-approval
```

for sensitive actions.

---

# 52. VISUAL MULTI-AGENT BUILDER

Create drag-and-drop canvas using @xyflow/react.

Canvas features:

- pan
- zoom
- minimap
- snap
- multi-select
- copy/paste
- delete
- undo
- redo
- duplicate
- keyboard shortcuts
- auto-layout
- validation
- execution highlighting

---

# 53. WORKFLOW NODE TYPES

Initial node catalogue:

### Input

Workflow input.

### Agent

LLM/agent node.

### Tool

Registered tool.

### Router

Conditional routing.

### Condition

Boolean expression.

### Transform

Transform structured data.

### Code

Sandboxed code.

### Retrieval

Knowledge retrieval.

### HTTP

API request.

### Database

Database query.

### Human Approval

Pause execution.

### Parallel

Run multiple branches.

### Merge

Merge results.

### Delay

Wait.

### Subflow

Invoke another workflow.

### Output

Final output.

### UI

Render dynamic UI.

### File

Generate artifact.

### Chart

Generate chart.

---

# 54. AGENT NODE

Configuration:

- agent
- model override
- instructions override
- tools
- structured output
- retry policy
- timeout
- input mapping
- output mapping

---

# 55. ROUTER NODE

Support:

- deterministic expression
- LLM classification

Example:

```text
Billing → Billing Agent
Support → Support Agent
Sales → Sales Agent
Otherwise → General Agent
```

---

# 56. PARALLEL EXECUTION

Allow fan-out:

```text
Input
  ├── Research Agent
  ├── Risk Agent
  └── Financial Agent
            ↓
          Merge
```

Execute safe branches concurrently.

---

# 57. HUMAN-IN-THE-LOOP

Human Approval node.

Workflow pauses and stores state.

Approval UI presents:

- task
- agent recommendation
- relevant data
- approve
- reject
- edit
- comment

Workflow resumes from persisted checkpoint.

---

# 58. WORKFLOW VERSIONING

Statuses:

```text
Draft
Published
Archived
```

Every publish creates immutable version.

Executions reference version.

---

# 59. WORKFLOW VALIDATION

Before publishing detect:

- unreachable nodes
- missing connections
- invalid schema mappings
- missing credentials
- unavailable models
- unavailable tools
- circular flows without explicit loop policy
- missing output
- invalid branches

---

# 60. WORKFLOW TEST MODE

Builder can execute workflow without publishing.

Display execution animation.

Each node displays:

- status
- duration
- input
- output
- model
- token usage
- cost
- errors
- retry
- tool calls

---

# 61. EXECUTION INSPECTOR

Provide trace tree.

Example:

```text
Workflow Run #1234

Input
 ↓
Supervisor                     620 ms
 ↓
Router                          80 ms
 ├─ Finance Agent            2.1 sec
 │    ├─ RAG                 210 ms
 │    └─ LLM                 1.8 sec
 │
 └─ Risk Agent               1.7 sec
      ├─ Database            350 ms
      └─ LLM                 1.2 sec
 ↓
Final Agent                   900 ms
```

---

# 62. CONVERSATION RUNTIME

Conversation entity.

Support:

- agent conversations
- multi-agent conversations
- streaming
- attachments
- multimodal messages
- citations
- tool status
- generated UI
- generated charts
- generated files

---

# 63. MESSAGE TYPES

Message content must support structured blocks:

```text
text
markdown
image
audio
file
citation
tool_call
tool_result
chart
ui
artifact
error
approval
```

Do not limit database message content to one text field.

---

# 64. CHAT UI

Features:

- streaming text
- Markdown
- code blocks
- syntax highlighting
- citations
- attachment previews
- copy
- regenerate
- like
- dislike
- stop generation
- retry
- edit user message
- conversation starters

---

# 65. FILE ATTACHMENTS

Conversation supports:

- image
- PDF
- document
- spreadsheet
- text

Files receive virus/malware scanning before processing where production infrastructure permits.

Apply:

- file size limits
- content type validation
- tenant quota

---

# 66. VOICE

Support:

### Speech-to-text

Audio → transcript.

### Text-to-speech

Assistant response → speech.

### Real-time voice

Bidirectional low-latency voice sessions where supported by model provider.

Configuration:

- model
- voice
- language
- interruptibility
- VAD
- response style
- system prompt

---

# 67. HUMAN HANDOFF

Agent can escalate conversation to a human operator.

States:

```text
AI
Handoff Requested
Waiting
Human Active
Returned to AI
Closed
```

Operator console supports:

- conversation queue
- assignment
- replies
- internal notes
- tags
- return to AI

---

# 68. CUSTOM ACTIONS

Allow actions after or during conversations.

Initial types:

- URL
- contact form
- custom form
- API-backed action
- workflow action

---

# 69. FORM BUILDER

Fields:

- text
- email
- phone
- number
- textarea
- select
- multiselect
- radio
- checkbox
- date
- datetime
- file

Validation:

- required
- min/max
- regex
- custom schema

---

# 70. ACTION CONDITIONS

Actions may appear based on:

- agent decision
- conversation intent
- workflow state
- collected attributes
- manually configured condition

---

# 71. COLLECTED DATA

Store form submissions.

Provide:

- table
- search
- filters
- configurable columns
- date range
- export
- submission detail
- conversation link
- action source

---

# 72. WEBHOOKS

Workspace webhooks.

Events:

```text
conversation.created
conversation.completed
message.created
action.submitted
workflow.started
workflow.completed
workflow.failed
handoff.requested
feedback.created
agent.published
```

Implement:

- signature verification
- retries
- delivery logs
- manual retry
- secret rotation

---

# 73. DEPLOYMENT

Agent/workflow deployments.

Channels:

### Hosted Chat

Generated URL.

### Embedded Widget

JavaScript embed.

### API

REST/streaming API.

### Messaging integrations

Connector based.

---

# 74. EMBED WIDGET

Provide standalone lightweight widget bundle.

Config:

- agent/deployment ID
- theme
- launcher icon
- position
- greeting
- width
- height
- language

Support responsive mobile interface.

---

# 75. DOMAIN RESTRICTION

For embedded deployments configure:

- public
- specific allowed domains

Validate origin server-side.

---

# 76. WHITE LABELING

Workspace/deployment customization:

- logo
- agent avatar
- colors
- fonts where appropriate
- launcher
- header
- welcome text
- powered-by visibility based on plan

---

# 77. CHANNEL CONNECTOR FRAMEWORK

Create generic channel interface.

Initial connectors:

- Web
- WhatsApp
- Facebook Messenger

Enterprise connectors architecture for:

- Salesforce
- Zendesk
- Zoho Desk
- Microsoft Teams
- Slack

Channel messages normalize into common Conversation/Message objects.

---

# 78. SECURITY GUARDRAILS

Create guardrail pipeline.

Stages:

```text
Input
 ↓
Input Guardrails
 ↓
Agent
 ↓
Tool Policy
 ↓
Model
 ↓
Output Guardrails
 ↓
User
```

---

# 79. INPUT GUARDRAILS

Configurable:

- jailbreak detection
- prompt injection detection
- PII detection
- secrets detection
- toxicity
- content policy
- custom regex
- custom classifier

Actions:

- allow
- mask
- block
- warn
- route
- escalate

---

# 80. OUTPUT GUARDRAILS

Configurable:

- PII
- secrets
- competitor mentions
- profanity
- toxicity
- unsupported claims
- custom regex
- custom classifier

---

# 81. TOOL POLICIES

Each tool supports policy:

```text
Auto Allow
Require Confirmation
Require Human Approval
Blocked
```

Policy can depend on parameters.

Example:

```text
read_customer → Auto Allow

refund < $50 → Confirmation

refund >= $50 → Human Approval
```

---

# 82. PROMPT-INJECTION DEFENSE

Treat retrieved/tool content as untrusted.

Do not allow external documents to overwrite system-level policy.

Separate:

- system instructions
- developer policy
- tool outputs
- retrieved content
- user input

Implement explicit context labeling.

---

# 83. SECRET MANAGEMENT

Never persist provider/API secrets unencrypted.

Use envelope encryption.

Production may integrate:

- AWS KMS
- GCP KMS
- Azure Key Vault
- HashiCorp Vault

Local deployment can use configured master encryption key.

---

# 84. RATE LIMITING

Limits:

- user
- IP
- deployment
- agent
- organization
- API key

Support:

- messages/minute
- requests/minute
- tokens/day
- cost/day

---

# 85. API KEYS

Workspace API keys.

Features:

- create
- label
- scopes
- expiration
- revoke
- last used
- rate limits

Display plaintext only once.

Store hash.

---

# 86. CONVERSATION MANAGEMENT

Conversation dashboard.

Filters:

- agent
- workflow
- deployment
- date
- user
- status
- rating
- handoff
- channel

---

# 87. FEEDBACK

Users can:

- like
- dislike
- optionally add comment

Operators can label:

- correct
- incorrect
- incomplete
- hallucination
- retrieval issue
- tool issue
- policy issue

---

# 88. RESPONSE CORRECTION

Operator can provide expected response.

Store:

```text
original response
corrected response
feedback reason
reviewer
timestamp
```

Never silently rewrite historical user-visible data.

Represent correction separately.

---

# 89. DATASET BUILDER

Allow selected conversations/feedback to become evaluation dataset examples.

Dataset item:

```text
input
expected behavior
expected answer optional
metadata
tags
```

---

# 90. EVALUATION SYSTEM

Support offline evaluations.

Dimensions:

- correctness
- relevance
- groundedness
- retrieval quality
- tool selection
- policy compliance
- latency
- cost

Evaluator types:

- deterministic
- human
- LLM judge
- custom

---

# 91. REGRESSION TESTS

Before publishing a new agent/workflow version, optionally run evaluation dataset.

Compare against previous version.

Show:

```text
Quality
Latency
Cost
Failures
```

Prevent publication based on configured quality gate.

---

# 92. ANALYTICS

Platform analytics.

Overview:

- conversations
- unique users
- messages
- success rate
- feedback ratio
- handoff rate
- average latency
- tokens
- estimated model cost

---

# 93. AGENT ANALYTICS

Per agent:

- usage
- active users
- conversation duration
- top questions
- top topics
- feedback
- unresolved questions
- knowledge gaps
- latency
- model cost

---

# 94. WORKFLOW ANALYTICS

Per workflow:

- executions
- success rate
- failures
- average duration
- node latency
- node failures
- token consumption
- tool calls
- costs

---

# 95. KNOWLEDGE ANALYTICS

Show:

- most retrieved documents
- failed retrieval queries
- zero-result queries
- frequently cited documents
- stale sources
- ingestion failures

---

# 96. COST ANALYTICS

Track provider cost estimates.

Dimensions:

- organization
- workspace
- agent
- workflow
- model
- user
- date

Allow configurable budgets.

---

# 97. ADMIN MODEL MANAGEMENT

Organization admins can:

- enable/disable providers
- allow specific models
- set defaults
- restrict expensive models
- set usage caps

---

# 98. INTEGRATIONS PAGE

Central integration registry.

Categories:

- AI Providers
- Embeddings
- Rerankers
- MCP
- Databases
- Cloud Storage
- Channels
- CRM
- Support
- Observability

Each integration has:

```text
Disconnected
Connected
Error
Disabled
```

---

# 99. ENVIRONMENTS

Support:

- Development
- Staging
- Production

Each environment may have:

- separate secrets
- deployments
- model configuration
- tool endpoints

Promote published versions between environments.

---

# 100. STORAGE

Use S3-compatible object storage.

Support:

- AWS S3
- Cloudflare R2
- MinIO

Store:

- uploaded documents
- generated files
- media
- exports

Database stores metadata, not giant binary blobs.

---

# 101. SEARCH

Global application search for:

- agents
- workflows
- knowledge bases
- conversations
- connectors

Do not initially introduce Elasticsearch unless actual scale requires it.

Use PostgreSQL search first.

---

# 102. NOTIFICATIONS

Notification system:

- in-app
- email-ready

Events:

- ingestion completed
- ingestion failed
- workflow failed
- human approval needed
- handoff waiting
- budget exceeded
- deployment error

---

# 103. DASHBOARD

Main workspace dashboard should show:

- agents
- workflows
- knowledge bases
- recent conversations
- recent runs
- alerts
- usage
- cost
- feedback health

---

# 104. PRODUCT NAVIGATION

Recommended primary navigation:

```text
Home

Build
  Agents
  Workflows
  Knowledge
  Tools

Operate
  Conversations
  Runs
  Approvals
  Collected Data

Evaluate
  Feedback
  Datasets
  Evaluations

Analytics

Deployments

Integrations

Settings
```

This is preferable to exposing implementation concepts directly.

---

# 105. AGENT TEMPLATES

Provide templates:

- Enterprise Knowledge Assistant
- Customer Support Agent
- Sales Assistant
- HR Assistant
- Database Analyst
- Document Analyst
- Research Agent
- Voice Assistant
- Form/Data Collection Agent

Templates create editable resources.

---

# 106. WORKFLOW TEMPLATES

Examples:

### Research workflow

```text
User
 ↓
Planner
 ↓
Parallel Research Agents
 ↓
Fact Verification
 ↓
Writer
```

### Customer support

```text
User
 ↓
Intent Router
 ├─ FAQ → RAG
 ├─ Account → API
 ├─ Technical → Specialist
 └─ Critical → Human Handoff
```

### Document processing

```text
Upload
 ↓
Classifier
 ↓
Extractor
 ↓
Validator
 ↓
Human Approval
 ↓
Export
```

---

# 107. STRUCTURED OUTPUTS

Agents can define JSON output schema.

Runtime validates response.

Retry/repair invalid structured output using bounded attempts.

Use typed structured output wherever downstream automation depends on the response.

---

# 108. AGENT-TO-AGENT COMMUNICATION

Agents should not directly call arbitrary agents by ID.

Expose agents through controlled sub-agent interfaces.

Supervisor can delegate to configured child agents.

Each delegated task includes:

- task
- permitted context
- output schema
- timeout

---

# 109. AGENT PERMISSIONS

An agent only has access to explicitly attached:

- knowledge bases
- tools
- subagents
- connectors
- secrets

Never give all workspace integrations to every agent automatically.

---

# 110. EXECUTION BUDGETS

Per agent/workflow:

- max steps
- max LLM calls
- max tool calls
- max tokens
- max runtime
- max estimated cost

Stop runaway loops.

---

# 111. LOOP SAFETY

Detect:

- repeated identical tool calls
- repeating state
- excessive routing cycles
- token runaway

Return controlled failure instead of continuing indefinitely.

---

# 112. ERROR HANDLING

Normalize failures:

```text
PROVIDER_ERROR
TOOL_ERROR
AUTH_ERROR
RATE_LIMIT
TIMEOUT
POLICY_BLOCK
INVALID_OUTPUT
RETRIEVAL_ERROR
WORKFLOW_ERROR
```

Users receive understandable error messages.

Developers receive detailed traces.

---

# 113. RETRIES

Use retry policies appropriate to failure type.

Never retry:

- validation errors
- permission errors
- policy blocks

Backoff retry:

- transient network failures
- provider 429
- provider 5xx

---

# 114. STREAMING EVENT PROTOCOL

Define internal event schema.

Examples:

```text
run.started
message.delta
message.completed

node.started
node.completed
node.failed

tool.started
tool.completed
tool.failed

retrieval.started
retrieval.completed

artifact.created

ui.render

approval.required

run.completed
run.failed
```

Frontend should render events progressively.

---

# 115. EXTERNAL AGENT API

Expose API:

```text
POST /v1/agents/{deploymentId}/messages
```

Streaming variant via SSE.

Support:

- conversation ID
- input
- attachments
- context
- metadata

---

# 116. WORKFLOW API

```text
POST /v1/workflows/{deploymentId}/runs
GET  /v1/runs/{runId}
```

Allow synchronous or asynchronous invocation based on workflow type.

---

# 117. SDK

Eventually provide:

- TypeScript SDK
- Python SDK

Initial build only needs TypeScript SDK package internally, but API design must allow public SDKs later.

---

# 118. DEVELOPER WEBHOOK TOOL

Allow developers to expose application callbacks as tools through a simple schema.

Useful for integrations that do not warrant full MCP implementation.

---

# 119. LOCAL DEVELOPMENT

Provide Docker Compose development environment containing:

- PostgreSQL + pgvector
- Redis
- S3-compatible MinIO
- Temporal
- required worker services

One command should start development dependencies.

Example conceptual flow:

```text
pnpm install
docker compose up -d
pnpm db:migrate
pnpm dev
```

---

# 120. PRODUCTION DEPLOYMENT

Every component must be containerized.

Services should support:

- Docker
- Kubernetes
- Docker Compose/self-hosted deployment

Do not rely exclusively on Vercel/serverless.

The system must be deployable on private infrastructure.

---

# 121. CLOUD / ON-PREMISE

Architecture must support:

### SaaS

Central managed platform.

### Dedicated tenant

Dedicated infrastructure.

### On-premise

Customer-controlled environment.

Avoid hard dependencies on vendor-specific hosted services.

---

# 122. HEALTH CHECKS

Each service exposes:

```text
/health/live
/health/ready
```

Check required dependencies.

---

# 123. DATABASE BACKUPS

Provide documented backup/restore strategy.

Support point-in-time capable PostgreSQL deployments where available.

Object storage separately backed up/versioned.

---

# 124. DATA RETENTION

Workspace-level configurable retention:

- conversations
- files
- traces
- generated artifacts
- audit logs

Allow administrative deletion/export.

---

# 125. PRIVACY

Architect for:

- data export
- data deletion
- workspace deletion
- user deletion
- retention rules

Maintain referential/audit requirements without unnecessarily retaining user content.

---

# 126. ACCESSIBILITY

Target WCAG 2.2 AA.

Ensure:

- keyboard navigation
- focus state
- labels
- accessible dialogs
- screen reader semantics
- contrast
- canvas alternatives where practical

---

# 127. RESPONSIVE DESIGN

Builder optimized primarily for desktop.

Conversation/runtime interfaces fully responsive.

Support tablet and mobile for:

- chat
- analytics summaries
- approvals
- conversation monitoring

---

# 128. INTERNATIONALIZATION

Use an i18n architecture from the beginning.

Separate UI language from agent response language.

Prepare for:

- English
- German
- Burmese

without hardcoding strings into components.

---

# 129. TESTING

Use:

### Unit

Vitest.

### Components

React Testing Library.

### API integration

Real database test environment.

### End-to-end

Playwright.

### Agent evaluations

Custom evaluation framework described above.

---

# 130. SECURITY TESTING

Test:

- tenant isolation
- IDOR
- RBAC bypass
- SSRF
- prompt injection
- webhook signature
- SQL injection
- file upload handling
- tool authorization
- secret leakage
- rate limiting

---

# 131. CI/CD

GitHub Actions or equivalent.

Pipeline:

```text
Install
 ↓
Lint
 ↓
Typecheck
 ↓
Unit Tests
 ↓
Integration Tests
 ↓
Build
 ↓
Security Checks
 ↓
Container Build
 ↓
Deployment
```

---

# 132. CODE QUALITY

Rules:

- strict TypeScript
- no `any` unless justified
- clear domain boundaries
- dependency injection where valuable
- interfaces around external providers
- schema validation at system boundaries
- centralized error model
- migrations committed
- tests for critical business logic

Avoid excessive abstractions without practical value.

---

# 133. DOMAIN MODEL

At minimum design entities for:

```text
User
Organization
OrganizationMember
Workspace
WorkspaceMember
Role
Permission

Provider
Model
Secret
Integration
ApiKey

Agent
AgentVersion
AgentDeployment

KnowledgeBase
KnowledgeSource
KnowledgeDocument
KnowledgeChunk
Embedding

Tool
ToolVersion
MCPConnection

Workflow
WorkflowVersion
WorkflowNode
WorkflowEdge
WorkflowDeployment

Conversation
Participant
Message
MessageBlock

Run
RunStep
ToolExecution
ModelExecution

Action
ActionSubmission

Feedback
Correction

Dataset
DatasetItem
Evaluation
EvaluationRun
EvaluationResult

Webhook
WebhookDelivery

AuditEvent
UsageEvent
CostEvent
```

Do not implement all of these as huge JSON objects.

---

# 134. VERSIONING MODEL

Recommended:

```text
Agent
   ↓
AgentVersion 1
AgentVersion 2
AgentVersion 3
   ↓
Deployment → Version 3
```

Same pattern for workflows.

Draft editing should not mutate published versions.

---

# 135. SOFT DELETE

Use soft deletion where operational recovery/audit is useful.

Do not expose deleted records through normal queries.

Permanent deletion must be explicit.

---

# 136. PAGINATION

Use cursor pagination for high-volume objects:

- conversations
- runs
- messages
- audit logs
- collected data

Avoid huge offset scans.

---

# 137. EVENT MODEL

Introduce an internal application event bus interface.

Domain events:

```text
AgentPublished
ConversationCreated
MessageCreated
WorkflowCompleted
ActionSubmitted
FeedbackReceived
```

Initial implementation may be simple.

Architecture must allow migration to a distributed event broker later.

---

# 138. FEATURE FLAGS

Implement feature flags.

Useful for:

- experimental models
- generative UI
- new workflow nodes
- beta integrations

Allow workspace-level rollout.

---

# 139. SUPER ADMIN

Separate platform administration interface.

Functions:

- organizations
- users
- usage
- system health
- provider availability
- feature flags
- global limits
- support diagnostics

Super Admin capability must never be granted through normal workspace roles.

---

# 140. FIRST-RUN EXPERIENCE

New workspace onboarding:

```text
Create Workspace
 ↓
Connect Model Provider
 ↓
Create First Agent
 ↓
Upload Knowledge
 ↓
Test
 ↓
Publish
```

Do not make users configure every advanced subsystem before first success.

---

# 141. EMPTY STATES

Every major screen needs meaningful empty states.

Example:

"No knowledge bases yet"

with:

Create Knowledge Base

rather than an empty table.

---

# 142. COMMAND PALETTE

Add global command/search palette.

Examples:

```text
Create Agent
Create Workflow
Open Knowledge Base
Open Conversation
Go to Integrations
```

---

# 143. DESIGN SYSTEM

Build reusable product design system.

Core primitives:

- PageHeader
- ResourceCard
- DataTable
- FilterBar
- StatusBadge
- EmptyState
- SettingsSection
- FormField
- Drawer
- Dialog
- CodeEditor
- JSONViewer
- TraceViewer
- NodeInspector
- StreamingMessage
- UsageMetric

Do not build slightly different versions on every screen.

---

# 144. APPLICATION UX

The product must feel like an enterprise application builder, not merely a chatbot administration panel.

Primary user mental model:

```text
BUILD
↓
TEST
↓
EVALUATE
↓
PUBLISH
↓
MONITOR
↓
IMPROVE
```

Every major product flow should reinforce this lifecycle.

---

# 145. AGENT BUILD SCREEN

Recommended tabs:

```text
Overview
Instructions
Knowledge
Tools
Actions
Experience
Guardrails
Test
Versions
```

---

# 146. WORKFLOW BUILD SCREEN

Recommended layout:

```text
┌─────────────────────────────────────────────┐
│ Toolbar                                     │
├──────────┬───────────────────────┬──────────┤
│ Nodes    │                       │ Config   │
│          │       Canvas          │ Panel    │
│          │                       │          │
├──────────┴───────────────────────┴──────────┤
│ Test / Run / Logs                           │
└─────────────────────────────────────────────┘
```

---

# 147. TEST PLAYGROUND

Agent playground should allow:

- new conversation
- system state inspector
- context inspector
- retrieved documents
- tool calls
- trace
- token count
- cost
- latency

Debug information should be collapsible rather than cluttering normal chat.

---

# 148. DEPLOYMENT FLOW

```text
Draft
 ↓
Validate
 ↓
Optional Evaluation
 ↓
Publish Version
 ↓
Choose Environment
 ↓
Deploy
 ↓
Monitor
```

---

# 149. IMPORT / EXPORT

Allow resource export as versioned JSON package.

Export:

- agent configuration
- workflow
- tool definitions
- non-secret integration metadata

Never export secrets.

Support import into another workspace.

---

# 150. AGENT PACKAGE FORMAT

Define internal portable manifest such as:

```text
manifest.json
agent.json
workflow.json
tools/
knowledge-manifest.json
```

This makes future marketplace/template functionality possible.

---

# 151. FUTURE MARKETPLACE READINESS

Do not implement marketplace initially.

But architecture should allow later publishing of:

- agent templates
- workflow templates
- tools
- MCP connectors
- UI components

---

# 152. GENERATIVE UI COMPONENT REGISTRY

Registry entry:

```text
componentName
schema
renderer
allowedActions
version
```

Agent sees component descriptions/schema, not implementation code.

This allows safe extensibility.

---

# 153. AGENT UI RESPONSE FORMAT

Responses may conceptually contain:

```json
{
  "message": "...",
  "blocks": [
    {
      "type": "text",
      "content": "..."
    },
    {
      "type": "ui",
      "schema": {}
    },
    {
      "type": "chart",
      "schema": {}
    }
  ]
}
```

Use a versioned protocol.

---

# 154. MODEL FALLBACKS

Optional provider fallback chain.

Example:

```text
Primary model
 ↓ failure
Secondary model
```

Only fallback for suitable infrastructure/provider failures.

Do not silently swap model because it gave an undesirable semantic answer.

Record fallback in traces.

---

# 155. CACHING

Potential caching:

- model metadata
- MCP capability lists
- knowledge query results where safe
- connector metadata
- configuration

Never cache cross-tenant sensitive data without correct tenant keys.

---

# 156. COST CONTROLS

Workspace administrators configure:

- monthly budget
- warning threshold
- maximum model cost
- model restrictions

Surface estimated cost before or after large runs where feasible.

---

# 157. RUN CANCELLATION

Users can cancel long workflow executions.

Cancellation should propagate to:

- model calls where supported
- tool calls where supported
- Temporal operations
- child agents

State remains visible as Cancelled.

---

# 158. SCHEDULED WORKFLOWS

Allow workflows to run:

- manually
- API
- webhook
- schedule

Use Temporal scheduling.

---

# 159. EVENT-TRIGGERED WORKFLOWS

Future-ready trigger interface.

Examples:

- webhook received
- file uploaded
- CRM event
- scheduled timer

Do not tightly couple trigger implementation to the workflow engine.

---

# 160. ARTIFACTS

General Artifact entity.

Types:

- generated document
- spreadsheet
- presentation
- image
- data export
- workflow output

Track:

- creator
- run
- conversation
- MIME type
- storage
- created date

---

# 161. SEARCHABLE KNOWLEDGE PERMISSIONS

Knowledge bases have access permissions.

Agents can only retrieve KBs they are explicitly allowed to use.

Individual knowledge sources can later support finer ACLs.

Preserve ACL metadata in retrieval pipeline.

---

# 162. USER CONTEXT

Deployment API can provide authenticated end-user metadata.

Never trust arbitrary context keys automatically.

Deployment defines accepted schema.

Example:

```json
{
  "customerId": "string",
  "accountTier": "string"
}
```

Validate before runtime.

---

# 163. END-USER IDENTITY

Support anonymous and authenticated users.

Anonymous:

generated visitor/session ID.

Authenticated:

external subject ID + optional profile attributes.

Avoid requiring an Atenxion-platform account for end-user chat.

---

# 164. CONVERSATION EXPORT

Operators can export selected conversations:

- CSV
- XLSX
- PDF
- JSON

Permission controlled.

---

# 165. ANALYTICS PRIVACY

Analytics should aggregate where possible.

Do not expose message content unnecessarily in aggregate dashboards.

---

# 166. PERFORMANCE TARGETS

Design targets, excluding model/provider latency:

API CRUD p95:

< 500 ms under normal load.

Initial SSE connection:

< 500 ms.

Canvas editing:

smooth for at least 100 workflow nodes.

Conversation list:

cursor paginated.

Knowledge retrieval:

target sub-second retrieval before reranker/provider latency under ordinary datasets.

These are targets, not fake guarantees.

---

# 167. SCALING MODEL

Web and API services should be stateless.

Scale horizontally.

Workers scale independently.

Runtime workers scale independently from ingestion workers.

Major architecture:

```text
                    ┌───────────────┐
                    │    Browser    │
                    └───────┬───────┘
                            │
                    ┌───────▼───────┐
                    │    Next.js    │
                    │      Web      │
                    └───────┬───────┘
                            │
                    ┌───────▼───────┐
                    │   API Layer   │
                    └───┬───────┬───┘
                        │       │
               ┌────────▼─┐   ┌─▼────────────┐
               │PostgreSQL│   │Object Storage│
               │+ pgvector│   └──────────────┘
               └──────────┘
                        │
               ┌────────▼──────────┐
               │   Agent Runtime   │
               │     LangGraph     │
               └────────┬──────────┘
                        │
          ┌─────────────┼─────────────┐
          │             │             │
      LLM Providers    Tools         MCP
          │             │             │
          └─────────────┼─────────────┘
                        │
               ┌────────▼──────────┐
               │     Temporal     │
               │ Durable Workflows│
               └────────┬──────────┘
                        │
               ┌────────▼──────────┐
               │      Workers      │
               │ ingestion/sync/etc│
               └───────────────────┘
```

---

# 168. DEVELOPMENT APPROACH

Do NOT attempt to build all 160+ capabilities simultaneously.

Implement vertical slices.

Every phase must leave the repository in:

- compiling state
- tested state
- usable state

Do not create hundreds of placeholder components.

Do not mark features complete when only UI exists.

---

# 169. PHASE 0 — FOUNDATION

Implement:

- monorepo
- frontend shell
- API
- PostgreSQL
- migrations
- Redis
- object storage
- Temporal development environment
- authentication
- organization
- workspace
- RBAC
- audit infrastructure
- secrets
- basic design system
- OpenTelemetry

Acceptance:

A user can register, create an organization/workspace, invite members, and navigate the product securely.

---

# 170. PHASE 1 — SINGLE AGENT MVP

Implement:

- model registry
- OpenAI-compatible provider abstraction
- OpenAI provider
- Anthropic provider
- Gemini provider
- Agent CRUD
- AgentVersion
- prompt configuration
- playground
- conversations
- streaming
- publication
- hosted chat deployment

Acceptance:

A builder creates an agent, chats with it, publishes it, and accesses the hosted deployment.

---

# 171. PHASE 2 — KNOWLEDGE / RAG

Implement:

- knowledge bases
- document uploads
- ingestion worker
- chunking
- embeddings
- pgvector
- retrieval
- citations
- knowledge playground
- RAG tool
- website ingestion
- Q&A

Acceptance:

A user uploads documents, attaches KB to an agent and receives grounded cited responses.

---

# 172. PHASE 3 — TOOLING

Implement:

- Tool registry
- HTTP tool
- database tool
- web search adapter
- tool execution tracing
- tool policies
- MCP client
- MCP connector management

Acceptance:

An agent can safely use tools and display tool execution inside debugging traces.

---

# 173. PHASE 4 — MULTI-AGENT WORKFLOWS

Implement:

- visual canvas
- workflow schema
- LangGraph compilation
- Agent node
- Tool node
- Router
- Condition
- Parallel
- Merge
- Input
- Output
- human approval
- run inspector
- versioning

Acceptance:

Users can visually create and execute a multi-agent workflow.

---

# 174. PHASE 5 — ENTERPRISE OPERATIONS

Implement:

- advanced RBAC
- conversation management
- feedback
- corrections
- analytics
- usage
- cost tracking
- audit viewer
- API keys
- webhooks
- deployment environments

---

# 175. PHASE 6 — GENERATIVE EXPERIENCE

Implement:

- chart generation
- file generation
- UI schema
- component registry
- generative UI renderer
- UI action security
- forms
- collected data

Acceptance:

Agent can dynamically choose between text, chart, table, form and interactive action.

---

# 176. PHASE 7 — CHANNELS & VOICE

Implement:

- embed widget
- WhatsApp connector
- Messenger connector
- STT
- TTS
- real-time voice architecture
- human handoff

---

# 177. PHASE 8 — AI QUALITY PLATFORM

Implement:

- datasets
- evaluation runs
- regression tests
- LLM judge
- retrieval evaluation
- publish quality gates
- knowledge gap analysis

---

# 178. PHASE 9 — ENTERPRISE CONNECTORS

Implement progressively:

- Google Drive
- S3
- OneDrive
- SharePoint
- Salesforce
- Zendesk
- Zoho
- Teams
- Slack

Use connector abstraction.

---

# 179. PHASE 10 — HARDENING

Focus on:

- penetration testing
- tenant isolation
- load testing
- failover
- backups
- data retention
- deployment automation
- on-premise packaging
- performance
- accessibility
- documentation

---

# 180. CODING PROCESS

When implementing each phase:

1. Inspect existing repository first.

2. Understand existing patterns rather than replacing working architecture unnecessarily.

3. Produce a concise implementation plan.

4. Update database schema first where required.

5. Add backend/domain logic.

6. Add API.

7. Add frontend.

8. Add tests.

9. Run:
   - lint
   - typecheck
   - tests
   - production build

10. Fix all introduced errors.

11. Document:
   - what changed
   - migrations
   - environment variables
   - architectural decisions

Do not leave the project in a partially compiling state.

---

# 181. DATABASE POLICY

Every schema change requires migration.

Never use destructive migration against production data without explicit migration strategy.

Seed data should be separate from production migration.

---

# 182. ENVIRONMENT VARIABLES

Document all environment variables in:

```text
.env.example
```

Never commit actual credentials.

Validate environment variables at startup.

Fail fast with meaningful errors.

---

# 183. SECURITY RULES FOR CODEX

Never:

- expose secrets to browser
- hardcode API credentials
- execute arbitrary shell commands from model output
- execute arbitrary SQL
- trust model-generated HTML
- trust model-generated JavaScript
- allow cross-tenant resource IDs
- interpolate SQL strings
- expose internal stack traces publicly
- send unnecessary customer data to LLM providers

---

# 184. AI DESIGN RULE

The LLM is never an authorization layer.

For example, do NOT ask the LLM:

"Is this user allowed to delete customer X?"

Authorization is deterministic server-side application logic.

---

# 185. TOOL DESIGN RULE

LLMs decide that they want to invoke a tool.

The application decides whether they are permitted to invoke it.

The tool validates the parameters.

The application executes it.

---

# 186. WORKFLOW DESIGN RULE

Use deterministic nodes wherever deterministic logic is sufficient.

Do not use an LLM for:

- simple conditions
- arithmetic
- permissions
- data validation
- schema conversion
- known routing rules

Use LLMs where semantic reasoning is actually valuable.

---

# 187. UI DESIGN RULE

Prefer conventional predictable UI for administrative operations.

Use Generative UI primarily for runtime/end-user interaction.

Do not make basic settings pages dynamically generated just because AI can generate them.

---

# 188. MVP QUALITY BAR

This is not a mock application.

For a feature to count as implemented it must have:

- persisted data if appropriate
- authorization
- validation
- error handling
- real API integration
- loading states
- empty states
- tests for critical behavior

Do not substitute static mock JSON for backend functionality except inside explicit demos/tests.

---

# 189. DOCUMENTATION

Maintain:

```text
/docs/architecture.md
/docs/data-model.md
/docs/agent-runtime.md
/docs/rag.md
/docs/workflows.md
/docs/security.md
/docs/deployment.md
/docs/integrations.md
```

Use Architecture Decision Records for important architectural decisions.

---

# 190. FIRST CODING TASK

Do NOT start implementing the entire specification immediately.

Start by doing the following:

### Step 1

Inspect the repository.

### Step 2

Create:

```text
docs/product-spec.md
docs/architecture.md
docs/implementation-plan.md
```

based on this specification.

### Step 3

Design the target monorepo architecture.

### Step 4

Design the initial database ERD.

### Step 5

Define Phase 0 and Phase 1 implementation tasks.

### Step 6

Identify technical risks and dependencies.

### Step 7

Then implement Phase 0.

Do not proceed into later phases until the foundation is coherent.

---

# FINAL PRODUCT VISION

The finished platform should support this complete lifecycle:

```text
                      ENTERPRISE DATA
                           │
            ┌──────────────┼──────────────┐
            │              │              │
        Documents      Databases        APIs
            │              │              │
            └──────────────┼──────────────┘
                           ↓
                  ┌────────────────┐
                  │   KNOWLEDGE    │
                  │     LAYER      │
                  └───────┬────────┘
                          ↓
                    ┌───────────┐
                    │ AI AGENTS │
                    └─────┬─────┘
                          │
          ┌───────────────┼────────────────┐
          │               │                │
         RAG             Tools             MCP
          │               │                │
          └───────────────┼────────────────┘
                          ↓
                ┌────────────────────┐
                │ MULTI-AGENT        │
                │ WORKFLOW ENGINE    │
                └─────────┬──────────┘
                          ↓
             ┌────────────┼─────────────┐
             │            │             │
           Text          Voice     Generative UI
             │            │             │
             └────────────┼─────────────┘
                          ↓
             ┌─────────────────────────┐
             │ DEPLOYMENT & CHANNELS   │
             ├─────────────────────────┤
             │ Web                     │
             │ Embed                   │
             │ API                     │
             │ WhatsApp                │
             │ Messenger               │
             │ Enterprise Channels     │
             └────────────┬────────────┘
                          ↓
                ┌──────────────────┐
                │ AI OPERATIONS    │
                ├──────────────────┤
                │ Conversations    │
                │ Feedback         │
                │ Evaluations      │
                │ Analytics        │
                │ Cost             │
                │ Traces           │
                │ Governance       │
                └──────────────────┘
```

The product should ultimately be positioned as:

**An enterprise platform for building, orchestrating, deploying, governing, and improving AI agents and agentic applications.**

It should not merely be:

**a chatbot builder.**

The platform should make it possible for users to build applications where AI can:

**Understand → Retrieve → Reason → Collaborate → Act → Generate UI → Request Approval → Execute → Observe → Learn from Feedback.**


## New enrichment specification

The [Human Support, Intelligent Handoff and AI Copilot specification](human-support-spec.md) extends this product specification. Its phases A–G are tracked in [human-support.md](human-support.md). Deployment automation and additional monitoring are paused while this enrichment is implemented.
