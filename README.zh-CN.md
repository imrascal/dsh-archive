# @imrascal/dsh-archive

DeepSeek Harness（DSH）归档会话管理插件：在**设置面板**中管理归档会话与回收站。

- **存档会话**（Archived Sessions）：查看已归档的会话（从侧边栏隐藏但记录保留），单个或全部恢复，或移入回收站。
- **回收站**（Trash）：查看已删除的会话，恢复、彻底删除（purge）单条，或清空全部。

删除是**可逆的**：删除会话 = 移入回收站（`~/.dsh/trash`），只有 purge / 清空才是永久删除。
运行中的（live）会话拒绝删除，UI 会给出明确提示。

## 安装

```bash
dsh plugin --profile web add github:imrascal/dsh-archive
```

或从本地目录安装：

```bash
dsh plugin --profile web add file:C:/path/to/dsh-archive
```

安装后**重启应用**（宿主插件随启动加载），再刷新页面即可在 设置 → 存档会话 看到本插件。

> 需要 `pnpm` 在 PATH 中（`dsh plugin` 是 pnpm 转发器）。

## 工作原理

本插件把一个原本以「内置包补丁」形式存在的功能（`dsh-workspace` / `dsh-session-persistence-jsonl` /
`dsh-host-apiproxy` / `dsh-client-runtime` / `dsh-client-ui-workspace` 等 12 个文件的本地改动，见
[`patches/`](patches/) 参考补丁）重写为独立插件，并做了**双路径设计**：

| 路径 | 触发条件 | 行为 |
| --- | --- | --- |
| **原生**（native） | 宿主/客户端已带归档 API（如本仓库改过的安装） | 客户端直接调用 `ctx.workspaces.unarchiveSession / trashList / ...`，走宿主 RPC 与 store 帧同步，与内置实现完全一致 |
| **降级**（fallback） | 升级后宿主或客户端回到原版（stock） | 宿主半在启动时**自动补齐** `sessionPersistence` 的回收站层与 `workspaceRegistry` 的归档 API；客户端走插件自带的 `/dsh-archive/session` HTTP 接口 |

因此**应用升级后功能不丢**：回收站数据在 `~/.dsh/trash`（与应用代码无关，升级天然保留）；
归档集合在 workspace registry 的持久化状态中；无论升级后代码变成什么样，插件都会在运行时
feature-detect 并补上缺失的部分。

### 文件结构

```
dsh/index.js   宿主半：sessionPersistence 回收站层 + workspaceRegistry API + /dsh-archive/session 路由
dsh/client.js  浏览器半：设置面板「存档会话」区块（settings.section 插槽），零构建、仅依赖 react
cordis.patch.yml   bundle 挂载声明
patches/        内置补丁的参考 diff（宿主侧 6 个文件；客户端侧由插件直接取代）
scripts/        eval-check.mjs（客户端 factory 求值校验）与 host-logic-test.mjs（宿主半逻辑测试）
```

## 从「内置补丁」迁移到插件（可选）

如果你的 DSH 安装之前打过本地的存档管理补丁（本仓库的开发环境即是如此），插件与内置补丁会
重复注册同一个 `archived-sessions` 设置区块。迁移步骤：

1. 恢复 `node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js` 为官方原版
   （删除内置的 ArchivedSessionsSection 注册；宿主侧补丁可保留，插件会自动识别并 no-op）。
2. 安装并重启本插件。
3. 插件检测到同名区块已存在时会自动让位（stand down），避免重复；移除内置补丁后插件接管。

> 如果你希望宿主侧也回到官方原版（让插件全权接管），可先备份 `~/.dsh` 数据目录，再按
> `patches/` 的逆向来恢复宿主包，最后用本插件的宿主半自动补齐。回收站数据（`~/.dsh/trash`）
> 与归档集合不受影响。

## 数据安全

- 删除会话 → 移到 `~/.dsh/trash/<sessionId>-<时间戳>/`，可随时恢复。
- `彻底删除` / `清空回收站` 为永久操作，UI 有二次确认弹窗。
- 附件为内容寻址共享存储，删除会话不会删除附件。
- 运行中的会话（live）不可删除，宿主返回 `session-live`，UI 提示先切换或重启。

## 兼容性

- 目标 DSH：`0.1.0-rc.5` 起，同时兼容**原生 Web UI**（`dsh web` 浏览器访问）与**桌面版 GUI**
  （Electron 窗口）——两者共用同一套宿主服务与客户端 bundle，一份实现双端生效。
- 原版宿主（rc.5 未打补丁 / rc.6）：宿主半运行时补齐回收站层与 registry API；客户端走
  `/dsh-archive/session` 降级接口。
- 自带该功能的宿主——rc.5 打了内置补丁的，以及 **rc.7+（上游已原生合并同一套后端）**：所有
  步骤自动检测并 no-op；客户端直连原生 `ctx.workspaces` API。原生能力**每次调用实时判定**，
  服务晚到（rc.7 把 registry 放在 inject 门后）也会自动切回原生，不会永远卡在降级路径。
- `deleteSession` 采用 **fail-closed**：persistence 不具备回收站能力时拒绝删除（不删任何东西），
  插件永远不会驱动官方硬删除后端。
- 宿主半对每个补丁都有形状守卫，遇到不认识的形态安全跳过并打日志，不会拖垮应用。
- **Cordis 4 严格注入（0.2.1 修复）**：DSH Desktop 新版携带 `@deepseek-ai/cordis` 4.x，从 ctx
  直接读服务属性（`ctx.sessionPersistence`）仅在当前 fiber 的 `inject` 声明了该服务时才允许，
  否则抛 `cannot get property "X" without inject`。宿主半改用 `ctx.get(...)` 与补丁方法的接收者
  `this.ctx`（Cordis 会 shadow 回注册表自身 fiber）解析服务——绝不通过 `registry.ctx` 读追踪
  包装器（其 `ctx` 属性解析为**调用方**的 ctx）。旧版 Cordis 3.x 宿主两种写法都行；0.2.1 的写法
  在 Cordis 4 上是必须的。
- 平台：Windows / macOS / Linux（回收站为纯 Node `fs` 实现，无平台假设）。

## 开发

```bash
npm install                                # 拉取 @deepseek-ai/cordis devDependency
node scripts/host-logic-test.mjs        # 宿主半全链路：删除→回收站→恢复→purge→清空→live 拒绝
node scripts/host-robustness-test.mjs   # 晚到服务注入 + fail-closed 删除 + 路由按需补丁
node scripts/cordis4-strict-test.mjs    # 真实 Cordis 4 严格注入回归测试（0.2.1 "without inject" 修复）
node scripts/eval-check.mjs             # 客户端 bundle 求值 + apply + 插槽注册 + 晚到服务实时判定
```

## License

MIT
