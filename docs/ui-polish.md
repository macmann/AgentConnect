# Workspace UI polish

The workspace console keeps the green brand while improving navigation, control spacing and readable text across the existing studios.

- Navigation is grouped into Workspace, Build, Monitor and Manage. Phones and tablets use a keyboard-accessible drawer instead of an unlabeled icon rail. Organization selection remains available inside the drawer; workspace selection stays in the header on every page.
- Page and workspace selection are stored in the URL fragment and survive refresh, Back and Forward. Email verification, password reset and invitation links retain their existing behavior. URL fragments contain identifiers, never credentials.
- Forms, text areas, checkbox rows, tabs, tables and action buttons use consistent spacing. Tables scroll inside their panel on narrow screens. Dialogs remain within the viewport and restore keyboard focus when dismissed.
- Page descriptions explain each feature. Workspace creation actions appear on Overview and Workspaces. Agent prerequisites link directly to Models; existing knowledge/tool attachment actions remain available. Obsolete phase announcements are removed.
- API outages and non-JSON failures produce readable feedback. The initial connection screen offers retry. Member, secret and audit lists distinguish loading/error states from empty data. Workspace changes clear stale global notices. Signing out clears cached private data.
- A support operator's draft reply survives a concurrent join request. Agent attachment checkboxes have stable accessible names. Leaving an unsaved draft through All agents asks before discarding it.

Browser verification covers desktop and mobile navigation, refresh/Back, workspace switching, prerequisite links, keyboard skip navigation, dialog/drawer focus, viewport fit, API outage/retry, non-JSON failures and sign-out. The visual audit checks all 17 menu screens at 360, 768 and 1440 pixels. This is a UI polish pass, not an accessibility certification or verification of live external providers.

## Review previews

Screenshots use synthetic workspace data, not customer data or working credentials.

[Desktop overview](ui-polish/desktop.png) · [Mobile model form](ui-polish/mobile-form.png) · [Mobile navigation](ui-polish/mobile-navigation.png)
