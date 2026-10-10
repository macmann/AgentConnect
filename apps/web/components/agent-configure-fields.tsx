"use client";
import type { ReactNode } from "react";
import type { ConfigureIssue } from "./agent-configure-state";
export function ConfigureField({
  field,
  label,
  help,
  issues,
  children,
}: {
  field: string;
  label: string;
  help?: string;
  issues: ConfigureIssue[];
  children: (props: {
    id: string;
    "aria-invalid": boolean;
    "aria-describedby": string | undefined;
  }) => ReactNode;
}) {
  const id = `agent-${field.replaceAll(".", "-")}`,
    error = issues.find(
      (i) => i.field === field || i.field.startsWith(field + "."),
    );
  return (
    <div className="configure-field">
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        "aria-invalid": !!error,
        "aria-describedby":
          [help ? `${id}-help` : "", error ? `${id}-error` : ""]
            .filter(Boolean)
            .join(" ") || undefined,
      })}
      {help && <small id={`${id}-help`}>{help}</small>}
      {error && (
        <p id={`${id}-error`} className="configure-field-error">
          {error.message}
        </p>
      )}
    </div>
  );
}
export function ConfigureGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="configure-group">
      <h4>{title}</h4>
      {children}
    </section>
  );
}
