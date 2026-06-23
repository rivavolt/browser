# browser

A CLI to query and control Chrome and Firefox tabs, for interactive and
AI-agent use. JSON output by default.

```
browser tabs list                 list all tabs        -> JSON array
browser tabs content <id>          readable text of a tab
browser tabs open [url]            open a new tab, optionally at a url
browser tabs navigate <id> <url>   navigate a tab to a url
browser tabs activate <id>         focus a tab and its window
browser tabs eval <id> <js>        run JS in a tab, result as JSON
browser tabs move <id> --index <n> [--window <id>]
                                   reorder a tab, or move it to another window
browser tabs screenshot <id> [--out <path>]
                                   capture the visible viewport as PNG
browser tabs screenshot <id> --clip X,Y,W,H | --selector <css> | --full-page
                                   native region / element / full-page capture
                                   (these use chrome.debugger)
browser tabs wait <id> [--timeout <secs>]
                                   wait until a tab finishes loading
browser tabs close <id>...         close one or more tabs by id
browser windows list               list all windows     -> JSON array
browser --plain tabs list          line-oriented output for shells
browser --browser firefox ...      target Firefox instead of Chrome
```

## Architecture

Three components, mirroring the `userscripts-ext` precedent:

```
browser (CLI)  --unix socket-->  native host  --stdio native messaging-->  WebExtension
```

- **WebExtension** (`extension/`) — Manifest V3, one codebase for Chrome and
  Firefox. The service worker holds a persistent native-messaging port and
  proxies `chrome.tabs.*` / `chrome.scripting.*`.
- **Native host** (`host/`) — Rust. The browser spawns it per extension
  connection; it speaks native-messaging framing over stdio and also listens
  on a Unix socket, relaying CLI requests to the extension by request id.
  The socket path is namespaced per browser (`browser-ext-{chrome,firefox}.sock`
  under `$XDG_RUNTIME_DIR`).
- **CLI** (`cli/`) — Rust. Connects to the host socket, sends one JSON
  request, prints the reply.

## Protocol

CLI -> host -> extension: `{ "id": N, "method": "tabs.list", "params": {} }`.
Extension -> host -> CLI: `{ "id": N, "result": ... }` or `{ "id": N, "error": "..." }`.

## Adding a verb

1. Add a handler to `HANDLERS` in `extension/background.js`.
2. Add a `(group, verb)` arm to the `match` in `cli/src/main.rs`.

Both layers just dispatch on a method string, so no protocol changes are
needed.

## Build

`nix build` produces the `browser` CLI, the native host, the unpacked
extension, a signed Chrome CRX, an unsigned Firefox XPI, and native-messaging
host registrations for both browsers.

Firefox requires signed extensions; release Firefox is fed a Mozilla-signed
**unlisted** XPI built from the XPI here via `web-ext sign --channel=unlisted`
(see `sign-extension.sh` in the nixos-config repo).
