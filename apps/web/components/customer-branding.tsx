"use client";
import type { Branding } from "@agentconnect/schemas/customer-experience";
/** Controlled fields shared by the widget editor's draft and production-renderer preview. */
export function CustomerBranding({
  value,
  onChange,
}: {
  value: Branding;
  onChange: (value: Branding) => void;
}) {
  const field = <K extends keyof Branding>(key: K, v: Branding[K]) =>
    onChange({ ...value, [key]: v });
  return (
    <div className="widget-branding-fields">
      <p className="muted">
        Shared by hosted chat and the widget. A blank name uses the published
        agent name. A blank welcome uses the widget greeting, or the published
        welcome in hosted chat.
      </p>
      <label>
        Chatbot name
        <input
          maxLength={100}
          value={value.name}
          onChange={(e) => field("name", e.target.value)}
          placeholder="Published agent name"
        />
      </label>
      <label>
        Logo URL
        <input
          type="url"
          maxLength={1000}
          value={value.logoUrl}
          onChange={(e) => field("logoUrl", e.target.value)}
          placeholder="https://example.com/logo.png"
        />
        <small>Public HTTPS image; use a logo you control.</small>
      </label>
      <label>
        Welcome message
        <textarea
          rows={3}
          maxLength={1000}
          value={value.welcomeMessage}
          onChange={(e) => field("welcomeMessage", e.target.value)}
          placeholder="Published agent welcome"
        />
      </label>
      <div className="widget-color-fields">
        {(["primaryColor", "backgroundColor", "textColor"] as const).map(
          (key) => (
            <label key={key}>
              {
                {
                  primaryColor: "Button color",
                  backgroundColor: "Background color",
                  textColor: "Text color",
                }[key]
              }
              <input
                type="color"
                value={value[key]}
                onChange={(e) => field(key, e.target.value)}
              />
            </label>
          ),
        )}
      </div>
    </div>
  );
}
