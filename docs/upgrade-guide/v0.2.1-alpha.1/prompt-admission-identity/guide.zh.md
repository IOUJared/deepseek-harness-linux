---
kind: upgrade-guide
description: "提示词请求身份现在拒绝同一 ID 下不同或无法验证的重发载荷。"
---

# 提示词接收身份

[English](guide.md) | 中文

## 变更

Session RPC 消费方不能再用不同的提示词内容或投递元数据复用 `(sessionId, requestId)` 并得到接收确认。Host 在异步接收之前预留身份；保留中的相同请求共用原 Promise 与结果，载荷不同则返回 `session/prompt-conflict`，原因是 `PAYLOAD_CHANGED`。已有旧版接收记录缺少原请求摘要时，返回 `PAYLOAD_UNVERIFIABLE`，而不是确认载荷等价。历史 Inbox 插入在领取或移除后、`user/message` 出现前仍是正向接收证据。通用接收失败只暴露固定的 `PROMPT_ADMISSION_FAILED`，不再返回原始异常原因。

新的只读 `session.promptAdmission` 接口区分正向接收、接收中、保留的明确派发前拒绝与 unknown。它不激活冷态 Agent，也不重试写入。接收不代表提供方完成或 fsync 确认。可选的 `user-rpc.promptFingerprint` 元数据沿用现有事件，不要求重写 Session 历史或强制格式迁移。

## 迁移

1. 为每个新的不可变 intent 分配独立的 `SessionPromptRequest.requestId`。接收状态不明时，保留原始投递模式、有序文本/图片/文件、图片元数据、文件 receipt 标识与原始时区，不用同一身份提交编辑后的内容。
2. 接收确认丢失后，在同一 Session 上调用 `session.promptAdmission({sessionId, requestId})`。不要自动重放提示词、修改载荷，或分配另一个身份来恢复结果不明的写入。`unknown`、证据缺失、查询失败与进程本地回执丢失都不授予重发权限。
3. 处理 `session/prompt-conflict`、`session/prompt-capacity` 与 `session/prompt-closed`。不要仅凭原异常代码把接收判为 rejected：Inbox 派发后的失败仍可能有正向接收证据。
4. 确认并发的相同请求只接收一次、同一 ID 下不同请求返回冲突，且冷态状态查询不会创建 Agent。对于旧记录，确认状态可返回 accepted，而等价载荷重发仍无法验证。状态与保留语义见 [Session Controller 参考](../../../../packages/api/session-controller/README.zh.md)。
