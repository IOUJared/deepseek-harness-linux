---
kind: upgrade-guide
description: "转发的 Host 事件队列及待完成的问题在超过配置的项数或 JSON 字节上限时会显式失败。"
---

# 有界的 Host 转发事件

[English](guide.md) | 中文

## 变更

转发事件的待消费队列及待完成的作用域调用原本无界。Gateway 现在分别限制内置 source 及各 Client 的待消费队列，默认上限为 128 项及 262144 UTF-8 JSON 字节；待完成调用另有独立上限，默认值相同。超限会报告 `gateway/event-overflow`，而非静默丢弃或委托问题。source 超限会结束注册；Client 超限只撤销该代次，保留其他 Client 的投递。

source factory 接收第二个参数 `TypertRemoteEventBuffer`。现有单参数 factory 仍兼容类型要求，但若不使用该参数，就自行负责生产者侧缓冲。wire 事件字段及 Session 格式不变。

## 迁移

1. 检查 `cordis.yml` 中 Gateway 插件的 `config`。若默认值不适合部署，为 `remoteEventBufferItems`、`remoteEventBufferBytes`、`remoteEventPendingItems` 和 `remoteEventPendingBytes` 设置正安全整数。字节统计包括 JSON 元数据，不包括进程内能力或 socket 封装；参见[上限说明](../../../../packages/api/gateway/README.zh.md#forwarded-event-buffers)。
2. 自定义 source provider 可使用 `buffer.push(dispatch)` 并返回 `buffer.iterate(disposeListeners)`；发布数据前先挂载清理回调。忽略所提供缓冲的 provider 必须自行限制队列。
3. 确认正常投递，并确认超载产生显式失败，而非 `next()`。source 超限后，先修正负载或容量，再显式重新注册 source；仅重试流不会重建它。通过拥有者的查询或开启时的基线恢复依赖通知的状态。
