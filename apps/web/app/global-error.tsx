"use client";

// This boundary replaces the root layout. Keep it independent of application
// providers, router hooks, theme components and browser APIs during rendering.
export default function GlobalError() {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: "3rem 1.5rem",
          fontFamily: "system-ui, sans-serif",
          background: "#fff",
          color: "#0f172a",
        }}
      >
        <main style={{ maxWidth: "32rem", margin: "0 auto" }}>
          <h1>Unable to load Agent Connex</h1>
          <p>Please reload the page to try again.</p>
          <form>
            <button type="submit" style={{ padding: "0.75rem 1rem" }}>
              Reload page
            </button>
          </form>
        </main>
      </body>
    </html>
  );
}
