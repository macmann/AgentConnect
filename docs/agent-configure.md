# Agent configuration

Agent Studio keeps the lifecycle **Configure → Playground → Publish**. Configure shows one section at a time and retains one shared draft across all sections.

| Section    | Settings                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| Overview   | Name, internal/public descriptions, model, category, language, timezone; attachment summaries and readiness. |
| Prompt     | Structured instructions, existing raw prompt override, compiled prompt preview.                              |
| Knowledge  | Attachments, source health, retrieval mode and citations; advanced passage/relevance tuning.                 |
| Tools      | Read-only attachments and automatic planning; advanced call limit.                                           |
| Behavior   | Creativity presets, exact custom sampling, conversation memory and model-specific token limits.              |
| Experience | Welcome/fallback messages, editable conversation starters and supported rich response components.            |
| Advanced   | Shortcuts to technical controls, compiled preview, draft/model metadata and archive action.                  |

Desktop uses section navigation on the left; mobile uses a section dropdown and single-column fields. Save controls remain visible at the bottom. Summary-card Configure actions open the corresponding section. Readiness uses registered models, usable prompt instructions, ready knowledge sources, enabled tools and the existing validation schema. Unattached knowledge/tools are optional. Provider connectivity and existing quality gates are checked by the existing publish API; registration is not presented as a live connection test.

Advanced prompt mode retains the existing raw override semantics. Structured values remain editable and are preserved while overridden. The preview uses the same prompt renderer as the runtime and includes only configured instructions and response language, excluding runtime grounding and internal safeguards. Existing custom temperature and Top-P values are never changed merely by opening a section. Presets change temperature only on an explicit selection. Unsupported model sampling capabilities are identified; stored values remain accessible and the runtime retains its existing capability filtering.

Conversation starters remain an ordered string array with the existing six-item limit. Rich response block selection and confirmed public form permissions are retained. Unavailable saved attachments remain visible and removable; disabled tools cannot be newly attached. Knowledge rows show real ready/source counts and available indexing/failure statuses.

The sticky save bar shows actual draft differences. Discard restores the saved draft; **Save and test in Playground** validates and uses the normal single save operation before changing stage. Field errors and linked section error summaries use existing schema constraints and selected-model limits. Server validation remains authoritative. Revision conflicts retain local edits and require an explicit reload before saving again.

Navigation follows the existing hash routing convention, for example:

```text
/#view=Agents&organization=<id>&workspace=<id>&agent=<id>&stage=configure&section=knowledge
```

Refresh and browser back/forward restore stage and section. Section changes preserve unsaved edits; navigation away, workspace/organization changes, signing out and browser unload protect unsaved drafts. No additional API, database migration, environment setting or UI framework is introduced.

Synthetic desktop/mobile artifacts are under `docs/agent-configure/`. Deployment automation and additional monitoring remain paused.
