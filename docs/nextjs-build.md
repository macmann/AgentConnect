# Next.js production build: React dispatcher failure

The web production build must run with `NODE_ENV=production`. Use `pnpm build`
from the repository root or `pnpm --filter @agentconnect/web build`. The web
script starts the installed Next CLI through `apps/web/build.mjs`, which sets
production mode for that child process. It preserves other environment values
(including `NEXT_PUBLIC_API_URL`), CLI arguments and failure exit status. It does
not alter development commands, application runtime settings or Coolify configuration.

## Reproduced cause

On Next.js 16.4.0 with React/React DOM 19.3.0, inheriting
`NODE_ENV=development` into an unwrapped `next build --webpack` reproduces:

```text
Error occurred prerendering page "/_global-error"
TypeError: Cannot read properties of null (reading 'useContext')
```

Compilation and TypeScript succeed first. The failing hook belongs to Next's
`LayoutRouter` (`next/dist/client/components/layout-router`), where it reads
`LayoutRouterContext`. The same failure occurs with a minimal global error
boundary containing only HTML and a reset button; application providers and
theme controls are not necessary to reproduce it.

Next's CLI defaults to production only when `NODE_ENV` is unset; it warns about,
but preserves, an inherited development value. Production webpack compilation
defines `process.env.NODE_ENV` as production, while Next's external App Router
runtime (`next/dist/server/route-modules/app-page/module.compiled.js`) selects
its development runtime using the inherited process environment. These paths
select inconsistent React renderers/dispatchers. Moving components between
routes only changes where the inconsistency surfaces.

This was reproduced locally by varying `NODE_ENV`. The remote Coolify build
environment was not inspected, so this establishes a matching failure mechanism,
not direct observation of that server's environment.

## Dependency audit

The investigation ran all four commands:

```sh
pnpm why react
pnpm why react-dom
pnpm list react --depth 10
pnpm list react-dom --depth 10
```

All workspace manifests and the lockfile were inspected:

- One package installation each of React and React DOM, both 19.3.0.
- Next.js 16.4.0 declares `^19.0.0` among its accepted React/React DOM peers.
- Only the web application directly depends on React; shared workspace packages
  do not declare it as a normal dependency. API/worker trees include the same
  version through LangGraph SDK peers.
- Node resolution from React DOM, Next, Lucide, Radix Dialog, TanStack Query,
  React Hook Form and React Flow reaches the same physical React installation.
- Next's own vendored React runtimes are intentional framework internals; do not
  replace them with webpack aliases or pnpm overrides.

No React downgrade, dependency override or additional dynamic route flags are
needed for this failure.

## Regression verification

```sh
pnpm install --frozen-lockfile
rm -rf apps/web/.next
NODE_ENV=development pnpm build --force
node --test tests/release/web-build.test.mjs
```

The inherited development environment deliberately exercises the original
failure condition; the web launcher must normalize it before Next loads. CI
performs this full build, and the release tests verify package resolution,
environment normalization, argument forwarding and failure propagation.

Bypassing the launcher and directly invoking the Next CLI with development mode
can still reproduce the upstream mismatch. Do not use that invocation to build
production artifacts. Runtime deployment containers should also use
`NODE_ENV=production`.
