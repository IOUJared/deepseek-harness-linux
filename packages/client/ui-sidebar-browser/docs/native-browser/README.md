---
kind: "package-reference"
description: "Trusted-shell Browser bridge for isolated Linux native guests."
---

# Linux native Browser bridge

English | [中文](README.zh.md)

[Package](../../README.md)

## Selection and ownership

The existing Browser plugin selects `window.dshLinuxBrowser` when its `protocolVersion` is exactly `1`. Absence preserves Web/Electron selection; an unsupported Linux version fails instead of silently substituting an iframe. This global is independent of `dshDesktop` and makes no claim that the complete Desktop bridge exists. It adds no Cordis Service, native permission, JavaScript Tauri dependency, or plugin activation. The Browser row can remain disabled until the native owner meets this reference.

`createTauriPage` adapts the existing `BrowserPage` interfaces. `BrowserController`, Sidebar chrome, typed locale dictionaries, explicit restore, and address-only persistence remain shared. No guest DOM or fake iframe is created. `BrowserFrameState.sandboxEnabled` remains undefined: no native security toggle is offered.

The shell installs an immutable bridge only into its trusted top-level document. The complete type-only declaration is [LinuxBrowserBridge](../../src/types.ts); native code implements a closed list of operations, never an arbitrary command, JavaScript evaluation, label lookup, file path, or secret API. Payload decoding, native caller identification, and authorization belong to the shell transport, not to the existence of this global.

## Native operations

| Operation | Native obligation |
| --- | --- |
| `acquire(workspace)` | Return `{lease}` for an initially hidden, empty native guest. Workspace is an opaque account key, not permission to read its filesystem path. |
| `release(lease)` | Idempotently fence the lease, invalidate queued work, stop loading, disconnect signals and destroy the view. Resolve only after destruction. |
| `open(lease,url,requestId)` | Validate URL and ownership; accept a strictly increasing positive safe-integer command id, then start native navigation. Resolve on acceptance, not load completion. |
| `navigate(lease,action,requestId)` | Closed `back`, `forward`, `reload` enum; same ownership and command-order rules. Unsupported history traversal settles with a full state update, never a hanging promise. |
| `setBounds(lease,bounds)` | Validate finite positive `{x,y,width,height}` in trusted shell viewport CSS pixels. Convert shell zoom and OS scale once; refuse rectangles outside the owning content/window. |
| `setVisible(lease,visible)` | Hide/show without destroying history or the lease. Native overlay/window policy may always veto showing. |
| `getState(lease)` | Return the current full observation with the same sequence counter used by events. |
| `onState(lease,listener)` | Synchronously register a full-state listener before `getState`; return synchronous unsubscribe. |
| `onOpenRequested(lease,listener)` | Report `{lease,url}` only after denying native popup creation and validating an HTTP(S) target. Return synchronous unsubscribe. |

Lease identifiers are native-issued, unguessable, nonempty bounded strings, at most 128 characters, scoped to the caller shell document, native window and resolved workspace. A document reload/disconnect/window close revokes every lease even if the renderer cannot call release. Another document, window, guest or workspace cannot use a lease. The native dispatcher checks this on every operation; renderer maps are not authorization.

Acquire resolves the authoritative Workspace list with the existing cancellable resolver. Its key is `cwd:<canonical path>`, or `session:<session id>` when ungrouped. A frame captures that account once. Each lease owns a separate page/history; guests in the same account may share one ephemeral context. Different accounts, the trusted shell, and authentication/account views must not share a storage context. Destroy account context after its final lease; no persistent profile directories or user cookies are imported. Saved URL/title is the only restart restoration.

## Full state and events

A full state payload contains `lease`, `sequence`, `requestId`, `url`, `title`, `loading`, `canGoBack`, `canGoForward`, and `error`. `url` is the actual allowed main-document URI, or null before one commits; it is never the submitted URL substituted for an observation. `title` is observed native document metadata. `error` is null or `{code:number|null,description:string}`; errors report native load failure and set `loading` false. Successful retries clear errors. Native error diagnostics must exclude credentials and shell secrets.

`sequence` is a nonnegative safe integer, strictly increasing per lease for every state change. Queries return the latest sequence without incrementing it. The renderer subscribes first, queries second, and ignores stale/duplicate observations. `requestId` starts at zero and echoes the latest accepted renderer command. Redirects, native back/forward, fragments and page-initiated history changes retain it until another shell command is accepted. Native cancellation callbacks from an older command must not become the latest command's failure. Renderer-request ids and native sequence counters have different purposes.

Emit observations from native URI/title/loading/history notifications, main-document commits, failures, crashes, and all navigation commands. Do not obtain metadata by executing JavaScript in untrusted content. URL strings are bounded to 16,384 UTF-16 code units and titles/error descriptions to 4,096; counters and numeric codes must be safe integers. Native and transport validation applies these limits before serialization; [the renderer decoder](../../src/client/tauri/protocol.ts) repeats validation before publishing chrome state. The common parser refuses credentials, unsupported schemes and the shell origin for observed and popup URLs as well as address input.

## Cancellation and settlement

No wire method accepts an AbortSignal object. Workspace resolution and frame load waits have local AbortSignals. Command promises acknowledge native acceptance; page completion is exclusively an observation with the matching `requestId` and `loading:false`, or a native error. `TauriBrowserFrame.waitForLoad(signal)` rejects on caller cancellation, a superseding shell command, error, or frame disposal. Cancelling one waiter does not stop the shared page. The caller supplies its deadline.

Frame disposal aborts lifetime waits, removes subscribers before native destruction, stops geometry observation, awaits pending acquisition/accepted calls and then releases the lease. An acquisition completing after cancellation is released without opening or showing it. Repeated disposal joins one promise. Native transport must settle every outstanding promise on disconnect, deadline, native failure or shell teardown; an abandoned bridge promise prevents quiescent renderer teardown. Release is a native fence: requests racing it cannot recreate or reveal the guest. Native caller revocation remains the final cleanup guarantee if the shell crashes.

## Bounds and shell overlays

The presentation samples the committed viewport on animation frames, emitting geometry only when it changes; this follows ancestor layout, resize, scroll and floating transforms without replacing Sidebar. A missing, disconnected, hidden, inert, zero-size, nonfinite or partially offscreen viewport requests hiding. DOM menus/listboxes/dialogs overlapping the viewport also request hiding. Physical unmount hides the native view, while `keepMounted` and the occurrence signal retain page ownership until the tab closes or the plugin unloads.

Native child widgets do not obey HTML z-index. The shell must additionally arbitrate native visibility for every modal, menu, popover, drag overlay, window occlusion, collapse and floating transition, and must hide by default before geometry is valid. The DOM checks are conservative helpers, not a native overlay authorization policy. Keep the Browser row disabled if this arbitration is incomplete. Clip or reject bounds within the correct native window; do not accept renderer-supplied native window labels or handles. Fractional CSS positions require tested zoom/HiDPI conversion.

## Guest security requirements

Create an unprivileged native remote guest, not a Tauri application webview with automatic bootstrap scripts. It must never receive `__DSH_BOOT__`, `dshDesktop`, `dshLinuxBrowser`, private IPC nonces, Tauri invoke keys, Host authorization headers/tokens, shell cookies/storage, account data, environment secrets, or shell DOM access. Do not reuse the shell's UserContentManager, WebContext, related view, URI handlers or auth account profile. The bridge belongs only to the trusted main document; remote subframes cannot acquire it.

Deny permissions by default in the native executor, including filesystem/file chooser, shell/process, updater, microphone/camera, geolocation, notifications, clipboard access, browser debugging/inspector, downloads, persistent credentials, external protocol launching and native popup creation. Deny page calls that create a privileged window, change native window chrome, or print. No renderer permission is automatically granted. Denied HTTP(S) popups may become Sidebar requests, without a related native view or opener. Disable default context-menu actions that reopen inspector, download, print or spawn windows. TLS errors remain errors, never ignore-certificate-errors.

Allow only HTTP(S) main navigation and approved HTTP(S) popups. Revalidate every navigation, redirect and history traversal natively. Block the shell/Host/account endpoints and native/custom schemes, including their subresource access; a top-level URL filter alone does not stop requests to authenticated loopback services. Other unauthenticated loopback services remain allowed where native policy supports them. This is not a general DNS-rebinding firewall; never attach shell credentials to guest requests.

## Verified Rust API choices

The checked native source versions are Tauri `2.12.1` and `webkit2gtk` `2.0.2`, matching the Linux port's pinned dependencies. [Tauri Webview::with_webview](https://docs.rs/tauri/2.12.1/tauri/webview/struct.Webview.html#method.with_webview) executes on the main thread, and `PlatformWebview::inner()` returns a WebKitGTK WebView on Linux. Use it to locate the trusted shell's GTK container, not to grant guest native APIs.

The checked WebKit source provides `WebView::builder().web_context(...).user_content_manager(...)`, `WebContext::new_ephemeral()`, and `UserContentManager::new()`. Build a raw guest with a fresh content manager and an account-scoped ephemeral context, placed by the Rust owner in the shell's GTK container. [WebViewExt](https://docs.rs/webkit2gtk/2.0.2/webkit2gtk/trait.WebViewExt.html) provides `load_uri`, `go_back`, `go_forward`, `reload`, `can_go_back`, `can_go_forward`, `uri`, `title`, `is_loading`, `stop_loading`, and URI/title/loading notifications plus `connect_load_changed`, `connect_load_failed`, TLS-failure and web-process-termination signals. The generated `BackForwardList::connect_changed` binding is omitted in this version; refresh history flags from the usable native navigation/URI/load notifications rather than assuming that callback exists.

Use `connect_decide_policy` to deny forbidden navigation, `connect_permission_request` to deny permissions, `connect_create` to deny native popup creation, context-menu/file-chooser/dialog handlers for their policies, and `WebContext::connect_download_started` to cancel downloads. Native signals and GTK widgets remain Rust-owned and must be disconnected/destroyed on release. These are integration choices, not a compiled Rust implementation or a substitute for runtime denial and HiDPI/overlay tests.

## Validation scope

Package source tests exercise native-state decoding, observed redirects/history/errors, query/event ordering, popup denial, bounds, hide/remount leases, late acquisition release, load waits and plugin disposal. They use a native transport fixture and create no external WebKit process. Native enforcement, actual rendering, guest denial tests, clipping/overlays, shell zoom and WebKit history behavior require the Rust owner and cannot be established by TypeScript mocks.
