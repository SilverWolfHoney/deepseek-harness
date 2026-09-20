---
description: "可选的按步骤上下文，包含会话的 token 预算、压缩余量与累计用量，供启用或调优本插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-token-context

[English](README.md) | 中文

## 概述

`dsh-token-context` 告诉模型它还剩多少上下文。在符合条件的步骤上，它追加一条持久、带来源的读数，包含下一次请求的预估大小、路由的上下文容量、会话累计的提供方用量，以及（当部署声明了阈值时）距自动压缩还剩多少余量。没有它，模型只能盲规划：分不清一次请求仍然放得下、还是即将被压缩，并且只有在读到 checkpoint 前言时才得知历史已被替换。本插件需主动启用，读取 `ctx.tokenMeter`，不发起模型调用，也不添加工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当模型需要看见自身的上下文预算时，把本插件挂在 `dsh-token-meter` 旁边。每条读数都是持久历史中额外的一条 user 角色消息；当按步骤读数超出对话需要时，用 `refreshIntervalMs` 调度。

### 最小组合

必须挂载 meter：本插件报告的是 `dsh-token-meter` 注册的 `contextPressure` 与 `tokenUsage` 两个投影单元，因此它把该服务声明为依赖，而不是在缺少它时静默降级。

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-agent'
- name: '@deepseek-ai/dsh-token-context'
  config:
    compactionThresholdRatio: 0.8
```

### 声明依赖

以裸包名挂载本插件的组合，必须同时把它列在该组合所基于的解析清单里。对用户 profile 而言，这份清单就是 profile 自己的 `package.json`，与本 profile 安装的其他插件并列：

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-token-context": "link:D://dsh-plugins//dsh-token-context"
  }
}
```

Loader 会从启动器可见的每个 Node 根解析裸包，因此漏写这一条仍会激活本插件、也仍会追加读数。`@deepseek-ai/dsh-plugin-package-inventory-deepseek` 更为严格：每个官方 DeepSeek 请求都携带一份活跃插件包清单，而它只从 profile 目录解析其中每一项。无法解析的 manifest 会让请求准备失败，`dsh-llm-deepseek` 将其报告为 `DeepSeek request extension preparation failed`——这条消息既不指向本插件，也不指向缺失的 manifest。因此，挂载了本包却未声明它的 profile 会每一轮都失败，而读数仍照常出现在对话记录中。

在 Windows 上，目标位于另一个盘的 `link:` 依赖可能生成无法跟随的相对符号链接。此时应改为在包目录上建立 junction：

```powershell
New-Item -ItemType Junction -Path '<profile>/node_modules/@deepseek-ai/dsh-token-context' -Target '<package directory>'
```

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `refreshIntervalMs` | `0`（每个合格步骤） | 同一会话中两次持久注入之间的最小毫秒数 |
| `compactionThresholdRatio` | 未设置（不输出余量行） | 该部署的压缩后端压缩历史的上下文窗口占比 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-token-context)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 何时产生读数

当步骤进入、且投影中确实存在可报告的事实时，才追加读数，这要求至少有一个提供方报告过用量。因此会话的第一次请求不携带读数：在提供方报告用量之前 `pressureTokens` 与 `projectedTokens` 缺失，在路由声明容量之前 `contextWindow` 缺失。被循环拒绝的步骤不产生读数。

这两个字段在投影中都是可选的，因此插件只报告它掌握的内容：没有声明容量时只给出 prompt 大小，没有配置占比时完全省略压缩行。

`compactionThresholdRatio` 是该部署自己的压缩点，本插件无法自行发现。`dsh-compaction-basic` 默认为 `0.8`，profile 还可以按路由覆盖，所以会压缩的部署也必须在此声明该占比；不设置只会去掉余量行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

本节说明插件背后的设计；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计概念

本插件是一个前置的 `agent/pre-step` 监听器：先委托，然后在读数到期时追加一条带来源的 `UserMessage`。除一个记录最近注入时间的 host-only 投影单元外，它不持有自己的每会话状态，因此刷新调度无需进程内缓存即可在恢复后继续。

读取来自 `ctx.sessionProjections.snapshot()`，它提供 `contextPressure` 与 `tokenUsage` 经 schema 校验的客户端视图。`projectedTokens`——下一次请求的 prompt 将花费多少——正是该视图自己锚定的数字；从内部状态重算它只会复制 meter 的定价，而不是读取它。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：pre-step 监听器、读数渲染、配置校验 |

### 读数构成

占用行给出预估的 prompt 大小，仅在路由声明了容量时才补上容量与百分比。总计行累加互不重叠的提供方桶：未缓存输入与两个缓存桶之和是 prompt 侧，`cacheReadTokens` 作为缓存命中份额单独报告。压缩行位于最后，且仅在占比与容量都已知时出现；当预估大小已达到或超过阈值时，它直接说明这一点，而不是报告负数余量。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时，阅读以下页面。它们从本插件走向它所报告的度量，以及它所跟随的同组时钟插件。

- [Token meter](../../llm/token-meter/README.zh.md)——本插件所读取的、可重放的度量服务与投影单元。
- [Token-meter 子系统](../../../docs/subsystems/token-meter.zh.md)——`ctx.tokenMeter` 背后的度量语义。
- [压缩能力](../../compaction/README.zh.md)——按部署声明的阈值压缩历史的、对压力敏感的消费方。
- [时钟上下文](../time-context/README.zh.md)——本插件在追加调度与来源归属上所跟随的同组按步骤插件。
- [context 组地图](../README.zh.md)——其余请求上下文包。

-----

<a id="model-experience"></a>
## 模型体验

### 上下文预算读数

#### 模型看到什么

每条注入消息按顺序携带部署数据所支持的行。没有声明容量时，第一行改为 `<projected> tokens in the next request's prompt.`；占比与容量未能同时提供时，第三行不出现；预估大小已达到或超过阈值时，该行改为 `this request is at or past that threshold.`，而不是报告余量。

##### 受支持的行

```markdown
Context budget while preparing turn <turn>, step <step>: <projected> of <window> tokens used (<percent>%).
Session totals: <prompt> prompt tokens (<cached> cached), <output> output tokens.
Automatic compaction is configured near <threshold> tokens: <headroom> tokens of headroom left.
```

#### Token 影响

每条读数为请求增加约 40–60 个 token，并留在历史中，直到压缩遮蔽它。正的 `refreshIntervalMs` 会减少增加量；省略或设为 `0` 时，首次提供方用量之后的每个合格步骤都会增加一条。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使已有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定上下文预算读数何时不合适或需要特别的运维注意。它们是本包当前的约束，不是通用 token 记账对比，也不是任务清单。

- **首次提供方用量之前不报告任何内容**——会话的开场请求不携带读数，因此模型在没有任何预算数字的情况下开始任务。
- **读数低估了它自己所在的请求**——它在 pre-step 期间追加，因此 `projectedTokens` 定价的是不含本条读数自身重量的请求。
- **两次压缩之间的历史开销**——省略或设为 `0` 会为每个合格步骤保留一条读数；正的间隔会减少但不会消除这一开销，并可能让后续请求拿不到最新数字。
- **阈值占比是声明而来的，不是发现而来的**——本插件无法读取别的部署的压缩策略，因此 `compactionThresholdRatio` 与后端不一致时，报告的余量针对的是该后端并不使用的点。
- **每个到期步骤都读取一次完整投影快照**——`snapshot()` 会提供所有客户端可见单元；增加大量单元的部署要为每一步支付该开销。
- **数字继承 meter 的启发式误差**——预估大小锚定于提供方用量，其后的增量按每 token 四字符估算，因此 CJK 文本与 JSON schema 会被低估。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。注入读数是两个已注册投影单元在同一 revision 上的纯渲染，本插件自己的状态只是一个时间戳；独立检查只能重新运行同一折叠，那是通过复制实现来发现漂移，而不是观察一个可能分歧的关系。
