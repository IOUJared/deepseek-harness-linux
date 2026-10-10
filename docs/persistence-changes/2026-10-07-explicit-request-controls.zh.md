---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-07-explicit-request-controls

[English](2026-10-07-explicit-request-controls.md) | 中文

## 概述

为模型选择及 request-header 调用配置添加可选显式 serviceTier 与 textVerbosity，并为 subagent descriptor 添加 agentServiceTier 与 agentTextVerbosity。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-explicit-request-controls
baseline: false
changes:
  - root: "event:model/selection"
    previous: "2026-09-11-initial"
    after: "041111caf5b7db48fecf5668f2dbe5e8d9441816353c2f7d8245d2ddaafd8095"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-09-16-session-format-v4"
    after: "e6c1755329990e534502375ac02a6eeb09fff3e9e6b3b7e3f7d21d915c3ef0a6"
    decision: same-version
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "010e20432158fda87d1468194248ce13d75dcd1fd97e92a491f0346a6941d375"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

六个属性均为可选新增字段。已有记录保留缺省及提供方行为；显示默认值不会填入这些参数，也不会添加 adapter-default 标记。当前恢复保留显式参数并拒绝非法标量值。历史 schema 与已提交 Session 代际保持不变；无需提高 Session 或 SQLite 写入版本。

<a id="verification"></a>
## 验证

聚焦后端测试通过（59 个测试，另一次持久解析／投影／参数运行通过 49 个）。未经删减的内置 base+Web Loader 组合通过选择确认、持久投影与 header、对话请求捕获、任何提供方调用或 profile 写入前的拒绝、同路由变化、重启恢复及省略校验。新增当前格式 request-controls Session 通过已构建 headless profile 的刷新与无密钥回放；其四个 header 与仅路由变化的 notice 提供固定点证据。

<a id="dev-note"></a>
## 开发备注

无。
