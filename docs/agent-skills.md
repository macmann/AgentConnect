# Agent skills

Skills are reusable **procedural instructions** attached to agents. They differ
from knowledge bases (factual evidence) and tools (approved external operations).
The model follows a skill's instructions during normal chat; uploading a bundle
does not install software or grant additional tool permissions.

## Upload and attach

1. Open **Skills → Upload skill** in your workspace.
2. Select `SKILL.md` (case-insensitive) or a ZIP containing exactly one skill.
3. Review the parsed instructions, text references and compatibility warnings.
4. Open **Agents → Configure → Skills**, select the skill and choose its version.
5. Save and start a **New chat** in Playground to use changed attachments.
6. Test, publish an agent version and update its deployment through the normal
   lifecycle. Public deployments require **Allow in public chat** on active skills.

Builders, workspace administrators, organization administrators and owners may
upload and manage agent skills. Other workspace members can inspect them. Human
support routing skills are a separate feature and are unchanged.

The AI creation assistant can propose enabled workspace skill versions by name;
its review panel shows the proposed attachments. Review them in Configure before
saving. Uploaded instructions never become attached automatically.

## Supported formats

A standard file looks like this:

```markdown
---
name: report-writer
description: Write reports with findings, risks and next steps.
---

# Report writing

Clarify the audience. Use supplied or approved facts. Identify missing evidence.
Use Findings, Risks and Next steps headings. Preserve required citations.
```

YAML frontmatter supports multiline descriptions. Name and description must be
text (1–100 and 1–1,000 characters respectively). Plain Markdown is also accepted:
the first heading supplies the name, and the first paragraph supplies a short
description. The body must contain usable instructions.

A ZIP may contain the skill directly or inside one enclosing directory:

```text
report-writer/
  SKILL.md
  references/
    outline.md
  examples/
    sample.json
```

Supported references are UTF-8 `.md`, `.txt`, `.csv`, `.json`, `.yaml` and `.yml`
files. Paths remain relative to the skill directory. Remote links are not fetched.
Archives containing several `SKILL.md` files are rejected; upload each skill
separately.

**Executable scripts and binary assets are unsupported in this release.** Their
names appear in compatibility warnings, but their content is not retained as a
runtime file or executed. A bundle that requires Python, Bash, package
installation, filesystem access or another unsupported dependency cannot perform
that operation. Attach an existing approved read-only tool separately when its
supported operation fits the task. Frontmatter `allowed-tools` is informational
and never authorizes a tool. The model is instructed to explain missing
prerequisites rather than claim a script ran.

Try the [standalone example](examples/skills/report-writer/SKILL.md), or ZIP its
[folder](examples/skills/report-writer) with the optional text reference.

## Usage policy and context

Each agent can attach up to **five skill versions**, one version per skill.

| Policy      | Behavior                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Always load | Default. Add attached instructions without a selection call; include text references while they fit. This loads instructions but does not force them into unrelated answers. |
| Automatic   | A bounded model call selects up to three relevant skills and up to three reference files per skill. Selection failures skip skills and are visible in diagnostics.           |
| Disabled    | Add no skill context and make no selection call. Attachments remain configured.                                                                                              |

Automatic mode also accepts usage guidance such as “Use report writing for
formal summaries, skip greetings.” It adds latency and provider usage; Always
avoids that additional call. The selection call uses the agent's normal model
routing and capability settings, a 15-second deadline, strict validated IDs/paths
and at most 2,048 output tokens, capped by the agent output limit.

**Advanced skill settings → Skill context budget** defaults to 6,000 tokens and
can be set from 256–12,000. The model's remaining context is an additional limit.
Instructions are included whole or skipped, never cut in the middle. References
are added while space remains; omitted references are reported. Shorten large
skills or adjust the budget rather than expecting missing material to be
invented. Knowledge retrieval accounts for loaded skill context, and the final
provider request remains subject to existing context controls and quotas.

## Versions and live revocation

**Upload new version** creates an immutable version. Existing draft attachments,
Playground conversation snapshots and published agents retain their chosen
version IDs. A new upload does not silently change their behavior. Select a newer
version explicitly, save, start a new test chat, and publish/update deployments as
needed. The library shows recent versions for selection.

**Enable skill**, **Allow in public chat** and **Archive skill** are live controls.
Disabling or archiving stops future loading, including for published agents;
revoking public access stops public loading. Optional runtime skills are skipped
with diagnostics instead of breaking the whole response. Save/publication
validation rejects unavailable active attachments so builders can fix them. Old
version records remain for provenance. Skill text may already have influenced
past messages; revocation affects subsequent loading.

## Limits and handling

- Upload: 5 MB maximum; one file per request.
- ZIP: at most 64 entries, 1 MB expanded total, 256 KB per entry.
- `SKILL.md`: 64 KB; frontmatter: 8 KB.
- Readable text: 64 KB per reference and 256 KB total including `SKILL.md`.
- ZIP parsing occurs in memory with bounded native decompression and checksums.
  Absolute/traversal/ambiguous paths, duplicate paths, symlinks, encryption,
  multipart/ZIP64 archives, malformed structures and invalid UTF-8 are rejected.
- Original ZIP bytes, executable files and binary assets are not stored. The
  version retains validated instructions, supported references, ignored-file
  names, warnings and a processed-content hash.
- Instructions and selected references are sent to the configured model. Do not
  upload secrets. Skills cannot override server authorization, tool grants,
  public-access checks or citation requirements.

## Tracing, APIs and migration

Langfuse records `skills.resolve` and, for Automatic mode, `skills.selection`.
Metadata includes selected skill/version IDs, reference paths, token counts and
skip/fallback reasons. Instruction/reference text follows the existing
`LANGFUSE_CAPTURE_CONTENT` opt-in. Private run context breakdowns include `skills`
under Playground **Debug / Advanced**. Agent REST/MCP calls with execution details
include skill metadata alongside retrieval and tools. Workflow agent nodes use
the same resolution logic and pinned versions.

Apply migration **0044** before starting updated API/worker services:

```sh
pnpm db:migrate
```

Coolify bootstrap applies migrations automatically. No new environment variable
or external skills service is required. Existing agents have no skills by default
and make no extra queries or model calls for skills.
