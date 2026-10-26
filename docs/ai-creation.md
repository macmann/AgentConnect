# AI-assisted agent and workflow creation

Agent Connex offers three creation paths under **Agents → Create agent** and
**Workflows → Create workflow**:

| Mode              | Experience                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| AI guide          | A chat asks one question at a time about purpose, audience, resources and boundaries, then proposes a draft. |
| AI-assisted draft | Describe the desired assistant or workflow; refine its proposed draft through chat.                          |
| Manual setup      | Open Agent Configure, or the existing workflow template wizard/blank canvas. No model call is made.          |

## Configure the creation model

1. Register a chat model and its credential in **Models** / **Secrets**, then test its connection.
2. Open **Settings → Creation assistant** in the current workspace.
3. Select **Assistant model**, enable **AI-guided creation**, and save.

Only workspace administrators, organization administrators and owners can change
these settings. Builders can use the configured assistant; viewers cannot invoke
it. The assistant model is separate from each created agent's runtime model.
Normal model-provider allowlists, credentials and capability settings apply. No
additional AI account or SDK is required. Manual setup remains available if the
assistant is disabled, its model is archived, or its provider is unavailable.

Apply migration **0043** before starting the updated services:

```sh
pnpm db:migrate
```

Coolify bootstrap applies migrations automatically. The migration adds only
workspace creation-assistant settings; agent and workflow storage are unchanged.
Settings use optimistic revision checks. If another administrator saves first,
reload settings before trying again.

## Build an agent

Choose **AI guide** for questions or **AI-assisted draft** for a description.
For example:

> Help customers understand our savings products. Use the ready Product FAQ
> knowledge base. Answer clearly, cite approved information and ask a human when
> the available information cannot answer the question.

The assistant sees a bounded catalog of workspace model names, ready knowledge
bases, enabled read-only tools and published agent versions. It may propose
existing resources by ID; the server checks every reference against that catalog.
It cannot register a provider, upload documents or create a tool on your behalf.
Unavailable resources must be set up separately.

Review the proposed name, description, runtime model, attachments and prompt.
You can edit the name, description and role in the review panel, or ask for changes
in the conversation. **Use draft in Configure** opens the normal editor with
unsaved settings. Review other sections, save, test in Playground and publish
through the existing lifecycle. Original retrieval thresholds and permission
checks still apply. AI suggestions do not guarantee correct answers.

## Build a chain of agents

AI workflow creation uses **existing published agent versions**. Create, test and
publish those agents first; if none are available, the assistant explains that
prerequisite without spending model tokens. A workflow request might be:

> Use the Product Research agent to prepare an answer, then the Compliance Review
> agent to check it before returning the final response.

The proposal lists each step, its published agent and step-specific instructions.
After review, **Create workflow draft** saves a normal workflow with an Input
node, 1–8 sequential agent steps, and an Output node. Each step receives the prior
result. Nothing runs or publishes automatically.

The canvas remains the place to edit mappings, add branching/parallel paths,
review gates or tools, and configure API/scheduled triggers. Test the resulting
workflow before publishing. AI creation does not generate or publish new
specialist agents automatically; use the agent creation guide for those first.

## Review, privacy and limits

- Creation requests and catalog **names/IDs** go to the configured provider.
  Document contents, tool connection details and stored credentials are not
  included in the assistant prompt. Do not paste secrets or customer records.
- Conversations and proposals live in the current browser component. Leaving or
  restarting setup clears them. Agent drafts become persistent only after Save;
  workflow drafts are saved only after the explicit creation action.
- Up to 16 conversation messages are accepted, with 4,000 characters per message.
  Start over with a concise description if the conversation limit is reached.
- Calls have a 90-second timeout, a bounded output budget of at most 8,192 tokens
  (also limited by model capacities), context-size validation, and an endpoint
  limit of 10 requests per minute per client IP.
- Invalid JSON, unknown IDs, foreign-workspace references and wrong proposal
  types are rejected. No partial resources are created by generation.
- The server records settings/generation audit events without the transcript.
  Langfuse receives `creation.assistant` and provider observations; conversation
  content follows the existing `LANGFUSE_CAPTURE_CONTENT` opt-in.
- The assistant offers suggestions only. It never executes attached tools,
  retrieves document contents, silently changes an existing agent, or bypasses
  publication/quality gates.

## Troubleshooting

| Symptom                              | Action                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| AI buttons unavailable               | Ask an administrator to enable the assistant and select an available workspace model in Settings.                           |
| Provider unavailable                 | Test the selected model connection, its key and endpoint allowlists; manual setup still works.                              |
| Invalid configuration response       | Retry with a clearer description and the resource names you intend to use. Unsupported or invented references are rejected. |
| Context exceeded                     | Start over with a shorter description or configure a model with a larger context window.                                    |
| No published agents for workflow     | Build, test and publish agents before using the workflow assistant, or use manual setup.                                    |
| Workflow does not behave as expected | Inspect step mappings and instructions on the canvas, then test before publishing.                                          |
