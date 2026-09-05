# @mzwing/pi-permission-auto-review

> Source fork of upstream **0.2.0** (`8d196e4`), version `0.2.0-local.1`, for local installation.
> Verified with **Pi 0.85.0** and **pi-permission-system 26.3.1**. This package is not published to npm.
> See [the fork guide](LOCAL_FORK.md) for source provenance,
> test commands, compatibility limits, and activation/rollback instructions.

[![npm version](https://img.shields.io/npm/v/@mzwing/pi-permission-auto-review?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@mzwing/pi-permission-auto-review) [![CI](https://img.shields.io/github/actions/workflow/status/mzwing/pi-packages/release.yml?style=flat&logo=github&label=CI)](https://github.com/mzwing/pi-packages/actions/workflows/release.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-7.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://github.com/earendil-works/pi)

A [Pi](https://github.com/earendil-works/pi) extension that adds Codex-style automatic permission reviews to [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system).

## Differences between `@gotgenes/pi-permission-model-judge`

[@gotgenes/pi-permission-model-judge](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-model-judge) is a general-purpose model-based authorizer that can be used to evaluate any permission request.

Ours is mostly specialized for OpenAI's `codex-auto-review` model, which is trained to evaluate permission requests in the context of a coding assistant. Our extension aims at providing Codex-style automatic permission reviews for Pi's coding agent.

The bundled baseline is a Pi-specific adaptation of OpenAI Codex Guardian's [`policy_template.md`](https://github.com/openai/codex/blob/c4f42d161ae44a8d696ee9fb595709661979d187/codex-rs/core/src/guardian/policy_template.md) and [`policy.md`](https://github.com/openai/codex/blob/c4f42d161ae44a8d696ee9fb595709661979d187/codex-rs/core/src/guardian/policy.md) at revision [`c4f42d161ae44a8d696ee9fb595709661979d187`](https://github.com/openai/codex/commit/c4f42d161ae44a8d696ee9fb595709661979d187). It is bundled at build time; the extension never fetches policy text while reviewing an action.

## Install

```bash
pi install npm:@gotgenes/pi-permission-system # dependency
pi install npm:@mzwing/pi-permission-auto-review
```

This fork targets the installed Pi 0.85.0 CLI and `@gotgenes/pi-permission-system` 26.3.1.
The npm commands above install upstream, not this fork. Load the built fork through a supported local
package path as described in the [fork guide](LOCAL_FORK.md), with the npm reviewer's extension disabled first.
The polyfill is a library dependency, not a separate Pi extension.

## Enable

Add `"auto-review"` to pi-permission-system's config:

```json
{
  "authorizerChain": ["auto-review"]
}
```

The config is normally located at `~/.pi/agent/extensions/pi-permission-system/config.json`.

Extension config can be omitted. The defaults are:

```json
{
  "provider": "openai-codex",
  "model": "codex-auto-review",
  "reasoning": "low",
  "timeoutMs": 90000,
  "includeBaselinePolicy": true,
  "denialAction": "deny"
}
```

`codex-auto-review` is an official hidden model. The extension derives it from Pi's `openai-codex` provider and reuses the existing Codex login.

## Configuration

| Scope   | Path                                                           |
| ------- | -------------------------------------------------------------- |
| Global  | `~/.pi/agent/extensions/pi-permission-auto-review/config.json` |
| Project | `<cwd>/.pi/extensions/pi-permission-auto-review/config.json`   |

Project fields override global fields. `PI_CODING_AGENT_DIR` replaces `~/.pi/agent` when set.

| Field                   | Default             | Description                                  |
| ----------------------- | ------------------- | -------------------------------------------- |
| `provider`              | `openai-codex`      | Pi model-registry provider id                |
| `model`                 | `codex-auto-review` | Model id within the selected provider        |
| `reasoning`             | `low`               | Reasoning level for reviewer calls           |
| `timeoutMs`             | `90000`             | Total budget across all retry attempts       |
| `includeBaselinePolicy` | `true`              | Include the built-in Codex-style risk policy |
| `additionalPolicy`      | omitted             | Trusted operator policy appended to it       |
| `denialAction`          | `deny`              | `ask` sends model denials and an open circuit breaker to normal human approval |

See the [example config](config/config.example.json) and bundled [JSON Schema](schemas/config.schema.json). Unknown or invalid fields disable automatic decisions and fall through to the normal prompt.

Use `/permission-auto-review` in Pi's interactive TUI to edit and apply global or project config without reloading the session. Available subcommands:

```text
/permission-auto-review show
/permission-auto-review path
/permission-auto-review reset [global|project]
/permission-auto-review help
```

Custom providers and models must be defined in Pi's `~/.pi/agent/models.json`, then selected with this extension's `provider` and `model` fields. To replace the built-in risk policy completely, set `includeBaselinePolicy` to `false` and provide a non-empty `additionalPolicy`.

## Behavior and Limits

### Authorization evidence

The reviewer reads the current session's complete active branch with `SessionManager.getBranch()`, rather than only the post-compaction model context. This keeps original user authorization available after compaction without mixing in abandoned branches.

Only these transcript records can establish authorization:

- Pi session user-role messages (`source: "user"`);
- completed, non-cancelled responses to recognized `ask_user_question` and `plan_mode_question` calls (`source: "user_interaction"`).

Pi does not persist the original `input` event source on user-role messages, so `source: "user"` is a trust boundary provided by the Pi runtime rather than cryptographic proof of keyboard input. Trusted extensions can intentionally create such messages with `sendUserMessage()`; as with the rest of Pi's extension model, only trusted extension code should be installed.

Structured question responses are accepted only when the non-error result matches a preceding recognized tool call and are rebuilt from `details.answers` data. Free-form tool-result text is never promoted to user evidence. Assistant messages, ordinary tool calls/results, custom messages, and compaction/branch summaries remain untrusted even if their text claims to be user content.

Transcript rendering uses separate 10k-token message and tool budgets with per-entry truncation. The first and latest trusted records are retained first, then other trusted records from newest to oldest. The 40-entry recency cap applies only to assistant/tool evidence, so later tool activity cannot evict an already selected user authorization. Truncation indicates missing information; it does not itself raise intrinsic action risk.

### Permission boundaries

With `"denialAction": "ask"`, a model denial emits an advisory Pi notification with the request id,
rationale, risk and authorization grades, then returns the permission system's supported `{ kind: "defer" }`.
The normal permission dialog shows the proposed action and collects approval or denial. No second approval
dialog or approval wrapper is added. An open circuit breaker also defers, explaining that the action was
not reviewed. Provider and internal failures remain deferrals; failure messages expose categories only.

**Use exactly `"authorizerChain": ["auto-review"]` for this mode.** In 26.3.1, `defer` means the next
chain link, not necessarily a human; another automated link after this reviewer could decide instead.
This extension cannot skip links through the public API. A notification is advisory, not an approval.

Automatic review now requires an interactive TUI in both modes. Print/JSON requests defer to the
permission system's unavailable-authority denial. RPC requests defer to the RPC client's normal approval
flow, even though Pi reports `hasUI: true`. Deterministic rules may still allow ordinary operations before
this reviewer runs; the fork neither changes those rules nor bypasses OS restrictions.

- Model, authentication, timeout, provider, or response-format failures defer to the normal human prompt.
- Unexpected internal review failures also defer to the human prompt instead of escaping into the permission gate.
- Three consecutive model denials, or ten in the latest fifty reviews, open a circuit breaker until the next Pi turn. Human approval does not clear it. The default mode denies subsequent asks; `ask` mode delegates each to the human without another model call.
- pi-permission-system's delegation envelope prevents authorizers from auto-approving `path` and `external_directory` requests. An auto-review `allow` for those surfaces is deliberately downgraded to the normal human prompt; this extension does not bypass that boundary.

### Diagnostics

Each `auto_review.decision` emitted after transcript construction adds content-free context diagnostics (configuration failures that defer before a review do not have transcript diagnostics):

- `policyRevision`
- `contextSource` (`active-branch`)
- `transcriptEntriesRetained`
- `transcriptEntriesOmitted`
- `transcriptEntriesTruncated`
- `directUserEntriesRetained` / `directUserEntriesOmitted` / `directUserEntriesTruncated`
- `userInteractionEntriesRetained` / `userInteractionEntriesOmitted` / `userInteractionEntriesTruncated`
- `latestTrustedEntryRetained`

These fields distinguish missing or truncated authorization evidence from a model decision made after receiving trusted evidence. Transcript text and model rationale are not persisted. The records are written through pi-permission-system's existing permission-review log when that log is enabled.

## License

[MIT](LICENSE)
