---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-07-prompt-admission-fingerprint

[English](2026-10-07-prompt-admission-fingerprint.md) | 中文

## 概述

为持久化的用户 RPC 消息来源增加可选的 promptFingerprint 元数据，以按原始请求内容恢复提示提交状态。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-prompt-admission-fingerprint
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "12f008526af9325e3b8cf94ca322ead42f8e894a8b9d5469f29a39776ea9b682"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "22fa7e4c6fe2667c61e9a71c5479a5d1d3cbca383f9493bd5f9fb095f428924f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "50dc9b41724896e1c50ed723e1b7d6799fb1e64a59b1cd0df492fefbbcf36d90"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "3b55b762020d64cb76a51148b48edf5e7aaddbff7e7f816280aa7a1d5b3a42b2"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

不含该字段的已有记录仍然有效。Host 写入原始已声明请求的带版本 SHA-256 摘要；它不改变消息内容或派生的模型输入。旧读取器可以忽略这一可选来源元数据并保留已记录的消息。缺失、格式错误或版本不受支持的摘要不能证明请求内容相同：旧请求 ID 的重复提交被拒绝，但非修改型状态读取仍可报告已有的明确提交证据。Session 头、事件封装、写入版本与 SQLite 模式均不变。

<a id="verification"></a>
## 验证

持久化分类器在 agent/inbox/spliced、developer/message、session/title-llm-request 和 user/message 中识别到可选字段新增，无需提高版本。针对 Session 命令与提交状态的 53 项回归测试通过；实际 Loader 和 SDK 回放验证另行记录，本确认记录不暗示它们已通过。

<a id="dev-note"></a>
## 开发备注

无。
