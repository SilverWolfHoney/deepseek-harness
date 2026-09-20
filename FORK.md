# 这份 fork 加了什么

本仓库是 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的个人 fork，用来承载上游没有的插件 [`packages/context/token-context`](packages/context/token-context/README.md)：它让模型能看见自己的上下文预算。

上游的文件**一个都没有改动**。这是刻意的：`git rebase origin/master` 因此永远不需要解决冲突。

## 从零跑起来

与上游 README 的 [Run from source](README.md#run-from-source) 完全一致，不需要额外步骤：

```sh
pnpm install
pnpm run build
pnpm dsh web
```

`lib/` 是构建产物并被 gitignore 排除，所以 clone 下来必须先 `pnpm run build`，否则插件的运行时入口不存在。

## 启用 token-context

插件是 opt-in 的，构建完不会自动生效。在目标 profile 里做三件事，缺一不可。

### 1. 声明 profile 依赖

编辑 `$DSH_HOME/profiles/<profile>/package.json`，与其他插件并列：

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-token-context": "link:<仓库路径>/packages/context/token-context"
  }
}
```

### 2. 挂载插件

编辑同目录的 `cordis.patch.yml`：

```yaml
- insert:
    - id: token-context
      name: '@deepseek-ai/dsh-token-context'
      config:
        compactionThresholdRatio: 0.8
```

### 3. 换成 junction（Windows）

`pnpm install` 在目标与 profile 跨盘时会生成无法跟随的相对符号链接。手工建一个绝对路径的 junction 覆盖它：

```powershell
$p = "$env:DSH_HOME\profiles\<profile>\node_modules\@deepseek-ai\dsh-token-context"
Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Junction -Path $p -Target '<仓库路径>\packages\context\token-context' | Out-Null
```

**只做第 2 步会得到一个很坏的状态**：读数照常出现，但每一轮请求都失败。原因是 Loader 能从任意 Node 根加载插件，而 `plugin-package-inventory-deepseek` 只从 profile 目录解析活跃插件包清单，解析不到就让请求准备失败，报错还是一句不指向任何线索的 `DeepSeek request extension preparation failed`。

## 同步上游

`origin` 指向上游，`fork` 指向本仓库：

```sh
git fetch origin
git rebase origin/master
git push --force-with-lease fork feat/model-visible-context-budget
```

## 不在版本控制里的本机改动

工作区里通常留着一处**不属于本分支**的改动：`apps/cli/src/profile-boot.ts` 把源码启动的 `resolutionMode` 默认值从 `runtime` 改回 `link`。

它修复的现象是源码启动下每次工具调用都失败（`ctx.tools[TOOL_RUNTIME_SCHEDULER]` 为 undefined）——模块级 `Symbol()` 因 tsx 与 `lib/` 混用而存在两份。这是本机环境适配，**刻意不提交**，因为它 revert 了上游的一个 PR，提交后会让 fork 在该文件上永久分歧。

代价是它只存在于工作区：**换机器、或工作区被清理时需要手工重建**。
