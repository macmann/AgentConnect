"use client";
import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Plus } from "lucide-react";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import type {
  OperatorProfile,
  SupportPage,
  SupportCursor,
  SupportOperator,
  SupportSkill,
  SupportQueue,
} from "@agentconnect/schemas/support";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { supportCursor, statusLabel } from "./support-utils";
import { SupportQueueEditor } from "./support-queue-editor";
function useSupportList<T>(base: string, workspaceId: string, key: string) {
  return useInfiniteQuery({
    queryKey: ["support", workspaceId, key],
    initialPageParam: null as SupportCursor | null,
    queryFn: ({ pageParam }) =>
      requestJson<SupportPage<T>>(
        base + "/" + key + "?limit=100" + supportCursor(pageParam),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: key === "profiles" ? 10000 : false,
  });
}
export function SupportTeam({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: Role;
}) {
  const base = `/workspaces/${workspaceId}/support`,
    cache = useQueryClient(),
    profiles = useSupportList<OperatorProfile>(base, workspaceId, "profiles"),
    skills = useSupportList<SupportSkill>(base, workspaceId, "skills"),
    queues = useSupportList<SupportQueue>(base, workspaceId, "queues"),
    operators = useSupportList<SupportOperator>(base, workspaceId, "operators");
  const pp = profiles.data?.pages.flatMap((p) => p.items) ?? [],
    ss = skills.data?.pages.flatMap((p) => p.items) ?? [],
    qq = queues.data?.pages.flatMap((p) => p.items) ?? [],
    oo = operators.data?.pages.flatMap((p) => p.items) ?? [];
  const [edit, setEdit] = useState<OperatorProfile | "new" | null>(null),
    [queue, setQueue] = useState<SupportQueue | null>(null),
    [skill, setSkill] = useState<SupportSkill | "new" | null>(null);
  const manage = permitted(role, "support:supervise");
  const refresh = () =>
    cache.invalidateQueries({ queryKey: ["support", workspaceId] });
  return (
    <div className="support-team">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Operators</h2>
            <p>
              Configure workspace members for routing. Assigned cases reserve
              capacity before acceptance.
            </p>
          </div>
          {manage && (
            <Button onClick={() => setEdit("new")}>
              <Plus size={16} />
              Add operator profile
            </Button>
          )}
        </div>
        {profiles.error ? (
          <div className="empty">
            <p role="alert" className="error">
              {profiles.error.message}
            </p>
            <Button onClick={() => void profiles.refetch()}>
              Retry operators
            </Button>
          </div>
        ) : profiles.isPending ? (
          <p className="empty" role="status">
            Loading operators…
          </p>
        ) : !pp.length ? (
          <p className="empty">
            No support profiles yet. Add an eligible workspace member to start
            routing.
          </p>
        ) : (
          <div className="support-team-grid">
            {pp.map((p) => (
              <article className="support-operator-card" key={p.user_id}>
                <h3>{p.name}</h3>
                <span
                  className={"support-badge presence-" + p.effective_presence}
                >
                  {statusLabel(p.effective_presence)}
                </span>
                <p>
                  {p.active_case_count} / {p.capacity_limit} reserved ·{" "}
                  {p.available_capacity} free
                </p>
                <p>
                  {p.languages.length
                    ? p.languages.join(", ")
                    : "No languages configured"}
                </p>
                <p>
                  {p.skills.length
                    ? p.skills
                        .map(
                          (s) =>
                            ss.find((x) => x.id === s.skillId)?.name ?? "Skill",
                        )
                        .join(", ")
                    : "No skills configured"}
                </p>
                {(!p.enabled || !p.manual_availability) && (
                  <small>New assignments disabled</small>
                )}
                {manage && (
                  <Button
                    className="secondary"
                    onClick={() => setEdit(p)}
                    aria-label={`Edit operator ${p.name}`}
                  >
                    Edit profile
                  </Button>
                )}
              </article>
            ))}
          </div>
        )}
        {profiles.hasNextPage && (
          <Button
            className="secondary support-more"
            onClick={() => void profiles.fetchNextPage()}
          >
            Load more profiles
          </Button>
        )}
      </section>
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Skills</h2>
            <p>Reusable skills with proficiency from 1 to 5.</p>
          </div>
          {manage && (
            <Button className="secondary" onClick={() => setSkill("new")}>
              Create skill
            </Button>
          )}
        </div>
        {skills.error && (
          <p className="empty error" role="alert">
            {skills.error.message}
          </p>
        )}
        <div className="support-skill-list">
          {!ss.length && (
            <p>
              No skills yet. Create a skill before adding skill requirements to
              a queue.
            </p>
          )}
          {ss.map((s) => (
            <div key={s.id}>
              <span>
                <strong>{s.name}</strong>
                {!s.enabled && " · Disabled"}
                <small>{s.description}</small>
              </span>
              {manage && (
                <Button
                  className="secondary"
                  onClick={() => setSkill(s)}
                  aria-label={`Edit skill ${s.name}`}
                >
                  Edit
                </Button>
              )}
            </div>
          ))}
        </div>
        {skills.hasNextPage && (
          <Button
            className="secondary support-more"
            onClick={() => void skills.fetchNextPage()}
          >
            Load more skills
          </Button>
        )}
      </section>
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Queue routing</h2>
            <p>
              Manual, recommended or automatic assignment. A default queue
              receives new requests without a queue.
            </p>
          </div>
        </div>
        {queues.error && (
          <p className="empty error" role="alert">
            {queues.error.message}
          </p>
        )}
        <div className="support-skill-list">
          {!qq.length && (
            <p>No queues yet. Return to the inbox and choose Create queue.</p>
          )}
          {qq.map((q) => (
            <div key={q.id}>
              <span>
                <strong>{q.name}</strong>
                {q.is_default && " · Default"}
                {!q.enabled && " · Disabled"}
                <small>
                  {statusLabel(q.routing_strategy)} ·{" "}
                  {statusLabel(q.assignment_mode)}
                </small>
              </span>
              {manage && (
                <Button
                  className="secondary"
                  onClick={() => setQueue(q)}
                  aria-label={`Configure queue ${q.name}`}
                >
                  Configure routing
                </Button>
              )}
            </div>
          ))}
        </div>
        {queues.hasNextPage && (
          <Button
            className="secondary support-more"
            onClick={() => void queues.fetchNextPage()}
          >
            Load more queues
          </Button>
        )}
      </section>
      {operators.error && (
        <p className="error" role="alert">
          {operators.error.message}
        </p>
      )}
      {operators.hasNextPage && manage && (
        <Button
          className="secondary"
          onClick={() => void operators.fetchNextPage()}
        >
          Load more eligible users
        </Button>
      )}
      {edit && (
        <ProfileEditor
          key={edit === "new" ? "new" : edit.user_id}
          p={edit === "new" ? null : edit}
          operators={oo}
          skills={ss}
          base={base}
          onClose={() => setEdit(null)}
          onSaved={refresh}
        />
      )}
      {skill && (
        <SkillEditor
          key={skill === "new" ? "new" : skill.id}
          skill={skill === "new" ? null : skill}
          base={base}
          onClose={() => setSkill(null)}
          onSaved={refresh}
        />
      )}
      {queue && (
        <SupportQueueEditor
          q={queue}
          base={base}
          workspaceId={workspaceId}
          profiles={pp}
          skills={ss}
          onClose={() => setQueue(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
export function SupportEditorFrame({
  title,
  description,
  children,
  onClose,
  busy,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  onClose: () => void;
  busy: boolean;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content support-config-dialog">
          <div className="dialog-header">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button
                className="icon-button secondary"
                aria-label="Close support settings"
                disabled={busy}
              >
                <X size={18} />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description>{description}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function ProfileEditor({
  p,
  operators,
  skills,
  base,
  onClose,
  onSaved,
}: {
  p: OperatorProfile | null;
  operators: SupportOperator[];
  skills: SupportSkill[];
  base: string;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [userId, setUserId] = useState(p?.user_id ?? ""),
    [capacity, setCapacity] = useState(p?.capacity_limit ?? 5),
    [weight, setWeight] = useState(p?.priority_weight ?? 1),
    [timezone, setTimezone] = useState(p?.timezone ?? "UTC"),
    [languages, setLanguages] = useState(p?.languages.join(", ") ?? ""),
    [enabled, setEnabled] = useState(p?.enabled ?? true),
    [availability, setAvailability] = useState(p?.manual_availability ?? true),
    [selected, setSelected] = useState(p?.skills ?? []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <SupportEditorFrame
      title={p ? `Edit ${p.name}` : "Add operator profile"}
      description="Use an existing workspace member. Presence is controlled by the operator; a profile alone does not make them available."
      busy={busy}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await requestJson(`${base}/operators/${userId}/profile`, "PUT", {
              enabled,
              manualAvailability: availability,
              capacityLimit: capacity,
              priorityWeight: weight,
              timezone,
              languages: languages
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              skills: selected,
            });
            await onSaved();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <label>
            Workspace member
            <select
              aria-label="Workspace member"
              value={userId}
              disabled={!!p}
              required
              onChange={(e) => setUserId(e.target.value)}
            >
              <option value="">Choose a member</option>
              {operators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <div className="form-grid">
            <label>
              Capacity limit
              <input
                type="number"
                required
                min={1}
                max={100}
                value={capacity}
                onChange={(e) => setCapacity(Number(e.target.value))}
              />
            </label>
            <label>
              Priority weight
              <input
                type="number"
                min={1}
                max={10}
                required
                value={weight}
                onChange={(e) => setWeight(Number(e.target.value))}
              />
            </label>
            <label>
              Timezone
              <input
                required
                maxLength={100}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </label>
            <label>
              Language codes
              <input
                placeholder="en, my, th"
                value={languages}
                onChange={(e) => setLanguages(e.target.value)}
              />
            </label>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Profile enabled
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={availability}
              onChange={(e) => setAvailability(e.target.checked)}
            />
            Allow new assignments
          </label>
          <h3>Skills and proficiency</h3>
          {!skills.some((s) => s.enabled) && (
            <p>Create a skill in the Skills section first.</p>
          )}
          <div className="support-skill-picker">
            {skills
              .filter(
                (s) => s.enabled || selected.some((x) => x.skillId === s.id),
              )
              .map((s) => {
                const value = selected.find((x) => x.skillId === s.id);
                return (
                  <label key={s.id}>
                    {s.name}
                    {!s.enabled ? " (disabled)" : ""}
                    <select
                      aria-label={`Proficiency ${s.name}`}
                      value={value?.proficiency ?? 0}
                      onChange={(e) =>
                        setSelected((old) => [
                          ...old.filter((x) => x.skillId !== s.id),
                          ...(Number(e.target.value)
                            ? [
                                {
                                  skillId: s.id,
                                  proficiency: Number(e.target.value),
                                },
                              ]
                            : []),
                        ])
                      }
                    >
                      <option value={0}>Not attached</option>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n} / 5
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
          </div>
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button
            className="secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button disabled={busy || !userId} type="submit">
            {busy ? "Saving…" : "Save operator profile"}
          </Button>
        </div>
      </form>
    </SupportEditorFrame>
  );
}
function SkillEditor({
  skill,
  base,
  onClose,
  onSaved,
}: {
  skill: SupportSkill | null;
  base: string;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [name, setName] = useState(skill?.name ?? ""),
    [description, setDescription] = useState(skill?.description ?? ""),
    [enabled, setEnabled] = useState(skill?.enabled ?? true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <SupportEditorFrame
      title={skill ? "Edit skill" : "Create skill"}
      description="Disabled skills no longer satisfy routing requirements."
      busy={busy}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await requestJson(
              base + "/skills" + (skill ? "/" + skill.id : ""),
              skill ? "PUT" : "POST",
              { name, description, enabled },
            );
            await onSaved();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <label>
            Skill name
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Skill description
            <textarea
              maxLength={1000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Skill enabled
          </label>
        </fieldset>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Save skill
          </Button>
        </div>
      </form>
    </SupportEditorFrame>
  );
}
