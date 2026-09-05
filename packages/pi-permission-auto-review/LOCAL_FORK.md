# Local installation of the human-escalation fork

This fork adds an opt-in human decision path for model denials while retaining
the bundled upstream risk policy. Set `"denialAction": "ask"` to show the model's
rationale and defer to the permission system. The default remains `"deny"`.
See [Behavior and Limits](README.md#behavior-and-limits) for the full contract.

## Source provenance

The reviewer package is based on upstream
[`@mzwing/pi-permission-auto-review@0.2.0`](https://github.com/mzwing/pi-packages/tree/8d196e4ef0884cac8326c366191dad3f585d470a/packages/pi-permission-auto-review),
commit `8d196e4ef0884cac8326c366191dad3f585d470a`. All twelve source files embedded
in that npm release's source map matched the tag before patching.

The surrounding monorepo retains upstream history at
`f0de8bacc510f9b27591292d47ef57f98c022246`, where the reviewer was already 0.3.2.
Only this package was restored to the verified 0.2.0 baseline before applying the
human-escalation change. The net diff therefore also removes newer reviewer
refactors, registration changes and policy-sync machinery; it is not an upgrade
to 0.3.2. Other packages and the upstream MIT licenses are retained. The root
lockfile records the required reviewer dependency changes.

The package is marked `private` and versioned `0.2.0-local.1`. This repository
provides source for local installation; the upstream npm package remains separate.

## Verified runtime and build

The installed-runtime tests exercise Pi, pi-ai and pi-tui **0.85.0**,
`@gotgenes/pi-permission-system` **26.3.1**, `@mzwing/pi-polyfill` **0.0.1**,
zod **4.4.3**, and Node **26.8.1**. These are tested versions, not a claim about
every version accepted by the peer ranges. The monorepo's development catalog
still targets Pi 0.84.4.

Use a stable checkout of the reviewed `human-escalation` branch. Run from the
repository root with paths to existing installations:

```sh
export AUTO_REVIEW_TEST_PI_ROOT=/absolute/path/to/pi-coding-agent
export AUTO_REVIEW_TEST_PACKAGES_ROOT=/absolute/path/to/pi-agent/npm/node_modules
export JITI_FS_CACHE=false
node packages/pi-permission-auto-review/scripts/build-local.mjs
node --test packages/pi-permission-auto-review/test/installed/*.test.mjs
```

The build uses Pi's installed esbuild and runtime dependencies. It writes the
ignored `dist/index.js` and source map; it does not install dependencies or load
live Pi settings/authentication. The test suite uses synthetic evidence and
controlled provider responses, without live model calls or credentials.

All **50 installed-runtime tests** pass. They cover ordinary allow, default deny,
human approve/deny/dismiss, rationale display, circuit thresholds and reset,
provider/auth/timeout/format/internal failures, cancellation, unavailable UI,
deterministic denies, excluded path/directory surfaces, configuration and schema,
trusted evidence, forwarding target resolution, and Pi activation/reload without
duplicate registration. They validate routing and runtime compatibility, not model
classification accuracy. The original Vitest suite, type checking, tsdown declaration
generation and repository lint were not run with this installed-dependency workflow.

The Pi CLI bundle supports the tested loader integration. The unbundled SDK entry
in the tested installation could not load because `@earendil-works/pi-server` was
missing. The local builder produces the runtime extension; it does not repair that
separate SDK installation issue.

## Load exactly one reviewer

Record the existing package entries/resource filters, reviewer config and permission
chain before activation. Keep the original npm package installed for rollback.
Disable its extension resources and add this fork's **package subdirectory** together:

```json
{
  "packages": [
    {
      "source": "npm:@mzwing/pi-permission-auto-review@0.2.0",
      "extensions": []
    },
    "/absolute/stable/pi-packages/packages/pi-permission-auto-review"
  ]
}
```

Preserve unrelated package entries and use the original npm source string if it
differs. Pi loads local packages through their manifest; do not point it at the
monorepo root or a disposable worktree. Local and npm sources have different
identities, so equal package names do not prevent duplicate loads. Check project
overrides, standalone extension entries and CLI `-e` options too.

Use exactly `"authorizerChain": ["auto-review"]` in the permission-system config.
In 26.3.1, `defer` continues to the next link, so another automated link could
otherwise decide before a human. Preserve deterministic denies and sandbox limits.
Opt in with `"denialAction": "ask"`, retaining `"includeBaselinePolicy": true` and
the desired provider/model settings. The [example](config/config.local-fork.example.json)
uses a relative `$schema` path; omit that field or use the fork's absolute schema
path when copying it into a different directory.

Start or reload an interactive Pi session, verify a single reviewer and no
registration warning, and inspect `/permission-auto-review show`. A model denial
should show an advisory rationale followed by the normal action approval dialog.
Pin the checkout to a reviewed commit and update it explicitly after validation.

## Boundaries and rollback

Automatic review requires an interactive TUI. Print/JSON execution defers to the
permission system's unavailable-authority denial; RPC defers to the client's own
approval flow. The `path` and `external_directory` surfaces cannot receive an
automatic grant from this reviewer. Explicit permission denies and OS restrictions
remain authoritative. Notifications provide context and do not grant permission.

Forwarded subagent support requires an identified child, a real parent Pi session
and a live serving parent. Independent worker sessions do not gain an approval
route automatically. The tests cover target resolution and serving-side behavior;
they do not prove an end-to-end exchange for a separate worker launcher.

To roll back, disable/remove the local package entry, restore the saved npm
resource entry and permission chain, and restore the saved reviewer config.
Remove `denialAction` from every effective config layer when returning to upstream
0.2.0, whose strict schema rejects it. Reload Pi and verify one reviewer. Keeping
the original npm package installed makes rollback possible without a network
installation; the inactive local checkout can remain on disk.
