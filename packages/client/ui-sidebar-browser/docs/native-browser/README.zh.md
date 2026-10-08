---
kind: "package-reference"
description: "用于隔离 Linux 原生 guest 的可信 shell Browser bridge。"
---

# Linux 原生 Browser bridge

[English](README.md) | 中文

[本包](../../README.zh.md)

## 选择与所有权

现有 Browser 插件在 `window.dshLinuxBrowser.protocolVersion` 严格等于 `1` 时选择原生载体。没有该 global 时保留 Web/Electron 选择；不支持的 Linux 版本会报错，不会悄悄改用 iframe。它独立于 `dshDesktop`，不表示完整 Desktop bridge 已存在，也不新增 Cordis Service、Tauri JavaScript 依赖、原生权限或插件启用。原生 owner 满足本文要求前，Browser 条目可以保持禁用。

`createTauriPage` 实现已有 `BrowserPage`，复用 `BrowserController`、Sidebar 工具栏、类型化 locale 字典、显式恢复及只保存地址的持久化。不创建 guest DOM 或假 iframe。`sandboxEnabled` 为 undefined，不提供原生安全策略开关。

Shell 仅向可信顶层文档安装不可变 bridge。[LinuxBrowserBridge](../../src/types.ts) 是完整的仅类型声明。原生执行器只提供限定操作，不接受任意命令、JavaScript 求值、原生窗口标签、文件路径或秘密 API。Transport 负责 payload 解码、真实调用者识别和授权；global 的存在不是授权。

## 原生操作

| 操作 | 原生义务 |
| --- | --- |
| `acquire(workspace)` | 返回 `{lease}`，创建初始隐藏、空白的原生 guest。Workspace 是存储账户键，不授权读取其文件系统路径。 |
| `release(lease)` | 幂等撤销租约，拒绝排队及后续操作，停止加载、断开信号、销毁 view，销毁完成后才 resolve。 |
| `open(lease,url,requestId)` | 校验所有权和 HTTP(S) 地址，接受严格递增的正安全整数命令 id；resolve 表示接受命令，不表示加载完成。 |
| `navigate(lease,action,requestId)` | 只接受 `back`、`forward`、`reload`，执行相同权限及顺序检查；无法遍历 history 时仍须发布完整 state，不悬挂 promise。 |
| `setBounds(lease,bounds)` | 有限且正尺寸的 `{x,y,width,height}`，单位是 shell viewport CSS 像素；只转换一次 zoom/OS scale，拒绝超出所属内容或窗口的矩形。 |
| `setVisible(lease,visible)` | 隐藏/显示不销毁 history 或租约；原生覆盖层策略始终可以否决显示。 |
| `getState(lease)` | 返回与 event 共用 sequence 的完整当前观察。 |
| `onState(lease,listener)` | 在查询前同步注册完整 state listener，返回同步 unsubscribe。 |
| `onOpenRequested(lease,listener)` | 拒绝创建原生 popup 后，校验 HTTP(S) 地址并报告 `{lease,url}`；返回同步 unsubscribe。 |

租约是原生生成的不可猜测、非空、最多 128 字符的标识，绑定可信 shell 文档、原生窗口及 workspace。文档刷新、断连或窗口关闭会撤销全部租约，即使 renderer 无法调用 release。每次操作都必须在原生执行器检查所有权；renderer Map 不是权限检查。

复用可取消的 authoritative Workspace resolver：规范 CWD 对应 `cwd:<canonical path>`，无 Workspace 的 Session 对应 `session:<session id>`。Frame 只解析并捕获一次账户。每个 lease 拥有独立页面和 history；同账户 guest 可以共享 ephemeral context。不同账户、可信 shell 与认证账户 view 绝不能共享 context。最后一个账户租约释放后销毁 context，不导入持久 profile、用户 Cookie 或认证存储。重启只恢复保存的 URL/title。

## 完整 state 与事件

完整 payload 包含 `lease`、`sequence`、`requestId`、`url`、`title`、`loading`、`canGoBack`、`canGoForward`、`error`。`url` 必须是实际提交的允许主文档地址，在提交前为 null，不可拿请求地址冒充观察。Title 来自原生 metadata。Error 是 null 或 `{code:number|null,description:string}`；加载失败令 loading 为 false，成功重试清除 error，诊断不包含 shell 凭据或秘密。

Sequence 是按 lease 严格递增的非负安全整数；查询返回最新 sequence，不递增。Renderer 先订阅后查询，忽略旧及重复观察。RequestId 初始为零，回显最近接受的 shell 命令；redirect、fragment、页面自身导航与 history 变化保留该 id。旧命令的取消回调不得变成最新命令的失败。原生 URI/title/loading/history、主文档提交、加载失败、崩溃及每个导航命令都必须提供观察；不可在不可信页面执行 JavaScript 获取 metadata。

URL 最多 16,384 个 UTF-16 code unit，title 与 error description 最多 4,096，计数及错误码必须是安全整数。原生及 transport 在序列化前验证，[renderer decoder](../../src/client/tauri/protocol.ts) 在发布 chrome state 前再次验证。共同地址解析器同样拒绝观察与 popup 中的内嵌凭据、不支持的 scheme 和 shell origin。

## 取消与完成

Wire 方法不传递 AbortSignal。Workspace resolver 和 frame load wait 使用本地 signal；命令 promise 只确认原生接受。加载完成必须由匹配 requestId 且 loading 为 false 的观察或原生 error 表示。`waitForLoad(signal)` 在调用方取消、新 shell 导航、加载错误或 frame 释放时 reject；取消单个 waiter 不停止共享 guest，deadline 由调用者提供。

Dispose 先取消 lifetime wait 并断开订阅，再停止 geometry observer，等待 acquisition、已发命令完成后释放租约。取消后才返回的 acquisition 会释放而不打开或显示 guest。重复 dispose 共享一个 promise。Transport 必须在断连、deadline、原生故障或 shell teardown 时完成所有 promise；遗弃 promise 会阻止 renderer 清理。Release 是原生撤销屏障，与其竞争的命令不可重新创建或显示 guest；shell 崩溃后的最终清理由原生 caller revocation 保证。

## 尺寸与覆盖层

Presentation 按 animation frame 采样已提交 viewport，仅在 geometry 改变时发送，跟随 resize、scroll、祖先布局及浮动变换。不存在、断连、隐藏、inert、零尺寸、非有限或部分离屏的 viewport 请求隐藏；重叠的 DOM menu/listbox/dialog 也请求隐藏。物理 unmount 只隐藏 guest，`keepMounted` 与 occurrence signal 保持页面，直到关闭 tab 或卸载插件。

原生子控件不服从 HTML z-index。Shell 必须额外协调所有 modal、menu、popover、drag overlay、窗口遮挡、折叠及浮动，并在 geometry 合法前默认隐藏。DOM 检查只是保守辅助，不是原生显示授权；该协调未完成时保留禁用条目。Native owner 在正确窗口内裁剪或拒绝 bounds，不接受 renderer 提交的窗口标签或 handle。小数 CSS 坐标、zoom 与 HiDPI 转换需要真实测试。

## Guest 安全要求

创建非特权原生远程 guest，而不是自动注入 bootstrap 的 Tauri application webview。绝不能向 guest 注入 `__DSH_BOOT__`、`dshDesktop`、`dshLinuxBrowser`、私有 IPC nonce、Tauri invoke key、Host token/header、shell Cookie/storage、账户资料、环境秘密或 shell DOM 权限。不复用 shell UserContentManager、WebContext、related view、URI handler 或认证 profile。Bridge 只属于可信主文档，远程 subframe 不能获得它。

原生执行器默认拒绝 filesystem/file chooser、shell/process、updater、microphone/camera、geolocation、notification、clipboard、browser debug/inspector、download、持久凭据、外部协议和原生 popup；拒绝特权窗口创建、窗口 chrome 修改和打印。Renderer 不自动获得任何权限。允许的 HTTP(S) popup 仅转为无 opener 的 Sidebar 请求。禁用可打开 inspector、下载、打印或原生窗口的默认 context menu 项。TLS 错误保持错误，不忽略证书检查。

主导航与批准的 popup 只允许 HTTP(S)，每次导航、redirect 和 history 遍历都重新原生校验。Shell/Host/账户 endpoint 及 native/custom scheme 也须禁止 subresource 访问；只过滤顶层地址无法阻止 guest 请求认证 loopback 服务。策略支持时仍可访问其他无认证 loopback 服务。这不是通用 DNS-rebinding 防火墙；guest 请求从不附带 shell 凭据。

## 已验证的 Rust API

检查的本地源码版本为 Tauri `2.12.1` 与 `webkit2gtk` `2.0.2`，与 Linux port 固定依赖一致。[Tauri with_webview](https://docs.rs/tauri/2.12.1/tauri/webview/struct.Webview.html#method.with_webview) 在主线程执行，Linux `PlatformWebview::inner()` 返回 WebKitGTK WebView；可定位可信 shell GTK container，不用它授予 guest 原生能力。

WebKit 提供 `WebView::builder().web_context(...).user_content_manager(...)`、`WebContext::new_ephemeral()`、`UserContentManager::new()`。[WebViewExt](https://docs.rs/webkit2gtk/2.0.2/webkit2gtk/trait.WebViewExt.html) 提供 `load_uri`、`go_back`、`go_forward`、`reload`、history flag、URI/title/loading getter/notify、`stop_loading`、load_changed/load_failed、TLS failure 与 web_process_terminated signal。此版本生成代码省略了 `BackForwardList::connect_changed`；应从可用导航/URI/load notification 更新 history，而非假定该回调存在。

可使用 `connect_decide_policy`、`connect_permission_request`、`connect_create`、context-menu/file-chooser/dialog handler 及 `WebContext::connect_download_started` 执行拒绝策略。Raw guest 使用新的 content manager 和按账户隔离的 ephemeral context，由 Rust owner 放置到 shell GTK container，并在释放时断开信号和销毁 widget。这是接入建议，不是已编译 Rust 实现，也不替代真实安全、HiDPI、覆盖层及 WebKit 行为测试。

## 验证范围

Package source test 覆盖 state 解码、实际 redirect/history/error、query/event 顺序、popup 拒绝、bounds、隐藏/重挂载租约、延迟 acquisition 释放、load wait 及插件清理。它们使用 native transport fixture，不创建外部 WebKit 进程；真实渲染、guest 拒绝、原生 endpoint 过滤、clipping、overlay、zoom 与 history 必须由 Rust owner 验证。
