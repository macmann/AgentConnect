"use client";
import {
  bankingTemplates,
  type QuickAction,
  type SupportJourney,
} from "@agentconnect/schemas/bank-experience";
import { useQuery } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { Button } from "./button";
export function BankExperienceEditor({
  workspaceId,
  actions,
  journeys,
  onChange,
}: {
  workspaceId: string;
  actions: QuickAction[];
  journeys: SupportJourney[];
  onChange: (actions: QuickAction[], journeys: SupportJourney[]) => void;
}) {
  const workflows = useQuery({
    queryKey: ["customer-workflows", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string; version: number }[]>(
        `/workspaces/${workspaceId}/customer-workflows`,
      ),
  });
  const updateAction = (i: number, patch: Partial<QuickAction>) =>
    onChange(
      actions.map((a, j) => (i === j ? { ...a, ...patch } : a)),
      journeys,
    );
  const updateJourney = (i: number, patch: Partial<SupportJourney>) =>
    onChange(
      actions,
      journeys.map((a, j) => (i === j ? { ...a, ...patch } : a)),
    );
  return (
    <section aria-label="Quick actions and support journeys">
      <h4>Quick actions and support journeys</h4>
      <p className="muted">
        Buttons can send a message, populate the composer, collect journey
        details or offer customer care. Journeys perform no financial
        transaction. Use approved knowledge for guidance; do not collect
        passwords, PINs, OTPs or full account/card numbers.
      </p>
      <Button
        type="button"
        className="secondary"
        disabled={
          actions.length +
            bankingTemplates.actions.filter(
              (t) => !actions.some((a) => a.id === t.id),
            ).length >
            20 ||
          journeys.length +
            bankingTemplates.journeys.filter(
              (t) => !journeys.some((j) => j.id === t.id),
            ).length >
            12
        }
        onClick={() =>
          onChange(
            [
              ...actions,
              ...bankingTemplates.actions.filter(
                (t) => !actions.some((a) => a.id === t.id),
              ),
            ],
            [
              ...journeys,
              ...bankingTemplates.journeys.filter(
                (t) => !journeys.some((a) => a.id === t.id),
              ),
            ],
          )
        }
      >
        Add banking templates
      </Button>
      {!actions.length && <p>No quick actions configured.</p>}
      {actions.map((a, i) => (
        <details key={a.id} className="configure-group">
          <summary>
            {a.label || `Quick action ${i + 1}`} · {a.behavior}
          </summary>
          <label>
            Button label
            <input
              maxLength={80}
              value={a.label}
              onChange={(e) => updateAction(i, { label: e.target.value })}
            />
          </label>
          <label>
            Predefined message
            <textarea
              maxLength={1000}
              value={a.message}
              onChange={(e) => updateAction(i, { message: e.target.value })}
            />
          </label>
          <label>
            Action
            <select
              value={a.behavior}
              onChange={(e) =>
                updateAction(i, {
                  behavior: e.target.value as QuickAction["behavior"],
                  journeyId:
                    e.target.value === "journey"
                      ? (journeys[0]?.id ?? null)
                      : null,
                })
              }
            >
              <option value="send">Send message</option>
              <option value="populate">Populate composer for review</option>
              <option value="journey">Start support journey</option>
              <option value="handoff">Offer customer care</option>
              <option value="workflow">Run published workflow</option>
            </select>
          </label>
          {a.behavior === "workflow" && (
            <>
              <label>
                Published workflow
                <select
                  value={a.workflowVersionId ?? ""}
                  onChange={(e) =>
                    updateAction(i, {
                      workflowVersionId: e.target.value || undefined,
                    })
                  }
                >
                  <option value="">Choose a published version</option>
                  {workflows.data?.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} · v{w.version}
                    </option>
                  ))}
                </select>
              </label>
              {workflows.error && <p role="alert">{workflows.error.message}</p>}
              <WorkflowFields
                action={a}
                update={(patch) => updateAction(i, patch)}
              />
            </>
          )}
          {a.behavior === "journey" && (
            <label>
              Support journey
              <select
                value={a.journeyId ?? ""}
                onChange={(e) =>
                  updateAction(i, { journeyId: e.target.value || null })
                }
              >
                <option value="">Choose a journey</option>
                {journeys.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button
            type="button"
            className="secondary"
            onClick={() =>
              onChange(
                actions.filter((_, j) => j !== i),
                journeys,
              )
            }
          >
            Remove action
          </Button>
        </details>
      ))}
      <Button
        type="button"
        className="secondary"
        disabled={actions.length >= 20}
        onClick={() =>
          onChange(
            [
              ...actions,
              {
                id:
                  "action_" +
                  crypto.randomUUID().replaceAll("-", "").slice(0, 16),
                label: "New action",
                message: "How can you help me?",
                behavior: "populate",
                journeyId: null,
              },
            ],
            journeys,
          )
        }
      >
        Add quick action
      </Button>
      <h4>Support journeys</h4>
      {journeys.map((j, i) => (
        <details key={j.id} className="configure-group">
          <summary>
            {j.name} · {j.fields.length} questions
          </summary>
          <label>
            Journey name
            <input
              value={j.name}
              maxLength={100}
              onChange={(e) => updateJourney(i, { name: e.target.value })}
            />
          </label>
          <label>
            Description
            <textarea
              value={j.description}
              maxLength={500}
              onChange={(e) =>
                updateJourney(i, { description: e.target.value })
              }
            />
          </label>
          {j.fields.map((f, n) => (
            <fieldset key={n}>
              <legend>Question {n + 1}</legend>
              <label>
                Field key
                <input
                  value={f.key}
                  maxLength={64}
                  onChange={(e) =>
                    updateJourney(i, {
                      fields: j.fields.map((x, k) =>
                        k === n ? { ...x, key: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Field label
                <input
                  value={f.label}
                  maxLength={100}
                  onChange={(e) =>
                    updateJourney(i, {
                      fields: j.fields.map((x, k) =>
                        k === n ? { ...x, label: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Question
                <textarea
                  value={f.question}
                  maxLength={500}
                  onChange={(e) =>
                    updateJourney(i, {
                      fields: j.fields.map((x, k) =>
                        k === n ? { ...x, question: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <Button
                type="button"
                className="secondary"
                disabled={j.fields.length === 1}
                onClick={() =>
                  updateJourney(i, {
                    fields: j.fields.filter((_, k) => k !== n),
                  })
                }
              >
                Remove question
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            className="secondary"
            disabled={j.fields.length >= 8}
            onClick={() =>
              updateJourney(i, {
                fields: [
                  ...j.fields,
                  {
                    key: "detail_" + crypto.randomUUID().slice(0, 8),
                    label: "Detail",
                    question: "What information can you share about the issue?",
                  },
                ],
              })
            }
          >
            Add question
          </Button>
          <label>
            On completion
            <select
              value={j.completion}
              onChange={(e) =>
                updateJourney(i, {
                  completion: e.target.value as SupportJourney["completion"],
                })
              }
            >
              <option value="guidance">Retrieve approved guidance</option>
              <option value="handoff">Offer human investigation</option>
            </select>
          </label>
          <Button
            type="button"
            className="secondary"
            onClick={() =>
              onChange(
                actions.filter((a) => a.journeyId !== j.id),
                journeys.filter((_, k) => k !== i),
              )
            }
          >
            Remove journey and linked actions
          </Button>
        </details>
      ))}
      <Button
        type="button"
        className="secondary"
        disabled={journeys.length >= 12}
        onClick={() =>
          onChange(actions, [
            ...journeys,
            {
              id:
                "journey_" +
                crypto.randomUUID().replaceAll("-", "").slice(0, 16),
              name: "New support journey",
              description: "",
              completion: "guidance",
              fields: [
                {
                  key: "issue",
                  label: "Issue",
                  question: "What issue do you need help with?",
                },
              ],
            },
          ])
        }
      >
        Add support journey
      </Button>
    </section>
  );
}

function WorkflowFields({
  action,
  update,
}: {
  action: QuickAction;
  update: (patch: Partial<QuickAction>) => void;
}) {
  const fields = action.workflowFields ?? [];
  return (
    <div>
      <h5>Customer input fields</h5>
      <p className="muted">
        The workflow receives a JSON input containing the predefined request and
        these field names. Do not collect passwords or banking credentials.
      </p>
      {fields.map((f, index) => (
        <div key={index} className="configure-group">
          <label>
            Field name
            <input
              value={f.name}
              onChange={(e) =>
                update({
                  workflowFields: fields.map((v, i) =>
                    i === index ? { ...v, name: e.target.value } : v,
                  ),
                })
              }
            />
          </label>
          <label>
            Label
            <input
              value={f.label}
              onChange={(e) =>
                update({
                  workflowFields: fields.map((v, i) =>
                    i === index ? { ...v, label: e.target.value } : v,
                  ),
                })
              }
            />
          </label>
          <label>
            Type
            <select
              value={f.type}
              onChange={(e) =>
                update({
                  workflowFields: fields.map((v, i) =>
                    i === index
                      ? { ...v, type: e.target.value as typeof f.type }
                      : v,
                  ),
                })
              }
            >
              {["text", "email", "number", "textarea", "checkbox", "date"].map(
                (type) => (
                  <option key={type}>{type}</option>
                ),
              )}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={f.required}
              onChange={(e) =>
                update({
                  workflowFields: fields.map((v, i) =>
                    i === index ? { ...v, required: e.target.checked } : v,
                  ),
                })
              }
            />
            Required
          </label>
          <Button
            type="button"
            className="secondary"
            onClick={() =>
              update({ workflowFields: fields.filter((_, i) => i !== index) })
            }
          >
            Remove field
          </Button>
        </div>
      ))}
      <Button
        type="button"
        className="secondary"
        disabled={fields.length >= 12}
        onClick={() =>
          update({
            workflowFields: [
              ...fields,
              {
                name: "field_" + (fields.length + 1),
                label: "New field",
                type: "text",
                required: false,
              },
            ],
          })
        }
      >
        Add input field
      </Button>
    </div>
  );
}
