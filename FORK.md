# 这份 fork 加了什么

本仓库是 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的个人 fork，用来承载上游没有的插件 [`packages/context/token-context`](packages/context/token-context/README.md)：它让模型能看见自己的上下文预算。

上游的文件只动过一行：`.gitattributes` 里的 `local/*.patch -whitespace`。它让 pre-commit 的 `git diff --cached --check` 不对保存的 patch 报告尾随空格——patch 格式里"未改动的空行"上下文就是一个单独的空格，那是格式本身的一部分，不是笔误。除此之外没有任何上游文件被改动，`git rebase origin/master` 因此几乎不需要解决冲突。

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

它修复的现象是源码启动后**任何工具调用都挂**在 `Cannot read properties of undefined (reading 'prepare')`。`runtime` 模式把插件入口按绝对 `lib/` 路径交给 Loader（绕过 tsx），而 `lib/` 文件内部的 bare import 又被 tsx 按 tsconfig paths 改写成 `src`，于是同一个包存在两份实例、两个模块级 `Symbol()`，`ctx.tools[TOOL_RUNTIME_SCHEDULER]` 取成 `undefined`。改成 `link` 让整棵树都走 bare specifier 映射到 `src`，同源。`packaged` 分支仍强制 `runtime`，所以打包产物不受影响；附带好处是源码模式的热生效回来了（改 `packages/*/src` 不必重新构建）。

这是回退上游 `9ddef327a4`（PR #4471，"feat: resolution mode link to runtime"）的那行默认值。**刻意不提交**：它 revert 了上游一个有意的决定，提交后会让 fork 在该文件上永久分歧，每次同步上游都要重新解决。

它不在提交里，但导出保存在 [`local/profile-boot.patch`](local/profile-boot.patch)，所以不会随工作区清理而丢失：

```sh
git apply local/profile-boot.patch
```

同步上游前先丢弃它让 rebase 得以进行（`git checkout -- apps/cli/src/profile-boot.ts`），rebase 完成后再 apply 回来。如果 apply 失败，说明上游改动了这个文件，需要按上面说明的原因手工重新适配。
