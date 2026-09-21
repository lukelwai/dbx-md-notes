# Vendored: DBX Plugin Go SDK

This directory vendors the **official** DBX Plugin SDK for Go, distributed inside the
`@dbx-app/plugin-cli` npm package at:

```
sdk-root/plugins/sdk/go/dbx-plugin-sdk/sdk.go
```

`sdk.go` here is a **byte-for-byte copy** of the upstream file. Do not edit it — any change
risks silently drifting from the host's protocol expectations. Upstream README is kept as
`README.md`.

## Why vendor instead of importing the module

1. `github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk` is **not published to the Go module
   proxy** — `go get` fails with `unknown revision v0.1.0`.
2. The upstream module declares `go 1.22`. Importing it as a separate module makes toolchains
   older than 1.22 refuse to build (Go 1.20 has no automatic toolchain switching).
3. Vendored as a plain package inside this module, the sidecar needs only Go 1.20+ and builds
   **fully offline** — which is also how `dbx-plugin-files` handles its Rust SDK.

Import path inside this plugin: `github.com/lwai/mdnotes/dbxsdk`.

## Transport

`dbxpluginsdk.NewServer(metadata, handler)` reads JSON-RPC 2.0 requests from stdin one JSON per
line (JSON Lines) and writes responses the same way. That matches DBX manifest v1, which no
longer accepts an `entrypoints.backend.transport` field.

> The **framed** transport (5-byte header + payload) is a Rust SDK capability. A Go sidecar must
> stay on JSON Lines.

## Provided behaviour (why we use it rather than a hand-rolled loop)

- `plugin/initialize` is answered by the SDK itself with exactly
  `{protocolVersion, capabilities, plugin:{id,version}}`; if the host's advertised
  `protocolVersions` do not include 1, it returns error -32001.
- One goroutine per request, 8 MB line buffer, notices (requests without `id`) don't produce a
  response.

Those are three things a hand-rolled loop tends to get wrong, and getting them wrong is enough
for the host to discard the sidecar (which surfaces as "no persistence" in the UI).
