# Today Workspace

> Capture now. Organize later.

A lightweight personal workspace that helps you capture thoughts, organize tasks, and stay synced across devices.

Built with a local-first architecture, supporting Web, PWA, and Android.

一个克制、mobile-first 的个人工作台，用尽可能低的摩擦记录想法和任务。Today Workspace 同一套前端同时运行于 Web / PWA 与 Android：本地数据优先写入 IndexedDB，登录后通过 Supabase 跨设备同步。

[![Web](https://img.shields.io/badge/Web-ready-20211f)](https://today-workspace.vercel.app)
[![Android](https://img.shields.io/badge/Android-Capacitor-20211f)](./RELEASE.md)
[![PWA](https://img.shields.io/badge/PWA-installable-20211f)](https://today-workspace.vercel.app)
[![Supabase](https://img.shields.io/badge/Supabase-Auth%20%2B%20DB-2f5d49)](https://supabase.com)
[![Cloud Sync](https://img.shields.io/badge/Cloud%20Sync-enabled-2f5d49)](#data--sync)
[![Offline Ready](https://img.shields.io/badge/Offline-ready-2f5d49)](#data--sync)
[![Android CI](https://github.com/chivopic/today-workspace/actions/workflows/today-workspace-android.yml/badge.svg)](https://github.com/chivopic/today-workspace/actions/workflows/today-workspace-android.yml)

**在线体验：** [today-workspace.vercel.app](https://today-workspace.vercel.app) · **Android 下载：** [GitHub Releases](https://github.com/chivopic/today-workspace/releases)

当前代码版本：`0.4.0`（Android versionCode `6`）。发布与签名流程见 [RELEASE.md](./RELEASE.md)。

项目最初在 `chivopic/my-software` 中孵化，并于 2026-09-06 独立为长期维护仓库。迁移前的提交历史仍保留在原仓库中。

## 当前界面与使用方式

界面采用横线笔记本风格：纸色背景、页边线、衬线标题和大号日期。手机使用底部导航，宽屏使用左侧导航；支持浅色 / 深色主题，首页显示星期与农历日期（浏览器支持时）。

- **今天**：在输入框下切换“记录 / 任务”，回车保存；也保留 `/task 内容` 快捷命令。首页各显示最多 4 条待办和最近记录。
- **记录**：关键词搜索、新建和编辑长记录；列表显示简短时间标记。
- **任务**：新增、完成 / 取消完成，按待完成、全部、已完成筛选。
- **删除撤销**：删除记录或任务后，可在 6 秒内撤销最近一次删除。
- **设置**：主题、JSON 备份、邮箱注册 / 登录、密码找回及同步状态。

保存失败时保留输入并显示提示；保存过程中继续输入的内容也会保留。

旧版界面示意图保留在 [`docs/screenshots/`](./docs/screenshots/)，不代表当前界面。当前外观请查看在线体验。

## Design Philosophy

**Capture first. Sync everywhere. Own your data.**

- **Capture first** — 首页切换记录 / 任务；输入 `/task ...` 也可直接创建任务，先记下来，再整理
- **Sync everywhere** — 登录后通过 Supabase 跨设备同步；没网也能继续使用，网络不阻塞输入
- **Own your data** — 本地 IndexedDB 持久化，JSON 导出 / 导入备份，数据始终在你这边

Web / PWA / Android 共用一套产品逻辑。

## Architecture

```text
User
  │
  ▼
Web / PWA / Android
  │
  ▼
IndexedDB
  ├── UI Update (immediate)
  └── Outbox
        │
        ▼ when online + signed in
     Supabase
        │
        ▼
   Other Devices
```

每次新建、编辑、完成任务或删除时，实体更新与 outbox 入队在同一个 IndexedDB transaction 中完成。删除使用 `deletedAt` tombstone；同步成功后再清理对应 outbox 项。

## Data & Sync

| Capability | What you get |
| --- | --- |
| Instant Capture | 首页切换记录 / 任务；支持 `/task`；保存失败保留草稿 |
| Notes & Tasks | 记录搜索与编辑；任务完成与状态筛选；删除后短时撤销 |
| Cross-device Sync | Supabase Auth + Notes / Tasks 双向同步；分页拉取；tombstone 软删除；待同步数量与上次同步时间 |
| Offline Support | IndexedDB 本地持久化；本地 `outbox` 保存待同步修改；写入不等待网络 |
| Data Backup | JSON v2 导出 / 导入，兼容 v1；按更新时间与版本合并，不先清空现有数据 |

其他已实现能力：PWA（Vite PWA + Workbox）、Android（Capacitor 8，应用 ID `io.chivopic.today`）、GitHub Actions 构建 debug / 签名 APK·AAB、浅色 / 深色模式与移动端优先布局。

## 技术栈

- **Frontend:** Vanilla JavaScript + HTML + CSS
- **Build:** Vite 8
- **PWA:** `vite-plugin-pwa` + Workbox
- **Local data:** IndexedDB
- **Cloud:** Supabase Auth + Database
- **Android:** Capacitor 8
- **CI / Release:** GitHub Actions, JDK 21, Android SDK 36
- **Hosting:** Vercel

## Local-first 细节

Today Workspace 把“本地可用”当作默认状态，而不是降级模式。当前数据库沿用历史 key `test1-workspace`，避免升级后已有设备上的本地数据“消失”。当前 IndexedDB schema 为 **v3**，备份格式仍为 **v2**，两者版本独立。数据结构包含：

```text
notes
  id / text / createdAt / updatedAt
  userId / deviceId / version / deletedAt / syncStatus

tasks
  id / text / done / createdAt / updatedAt
  userId / deviceId / version / deletedAt / syncStatus

outbox
  id / store / entityId / operation / record / deviceId / queuedAt
```

v3 为 `notes.updatedAt` 与 `tasks.createdAt` 建立索引，首页通过游标读取所需条目；旧版本升级保留已有记录与 outbox。

### 同步行为与边界

- 登录后、已有会话启动时、恢复联网、页面重新可见，以及本地修改后会触发同步；设置中也可“立即同步”。本地修改使用 300 ms 防抖，同一时间只执行一轮同步。
- 先上传 outbox，再按 `id` 分页拉取记录与任务，每页最多 500 条。分页游标只用于当前这一轮；目前每轮仍遍历远端数据，尚未实现跨轮次的增量同步，也没有实时订阅。
- 上传成功只确认对应的记录快照；上传期间产生的新修改继续留在队列。拉取合并会跳过仍有待上传修改的记录，其余按 `updatedAt`、再按 `version` 判断新旧。
- 失败时保留队列并显示提示，可手动重试或等待下一次同步触发；尚无独立的退避重试机制。
- 首次同步会将本地数据绑定到账号，并移除未修改的初始示例。切换其他账号时会暂停同步，当前不支持同一浏览器内的多账号数据空间。

### 云端配置

本地记录与任务无需登录。当前 `cloud.js` 直接配置了 `SUPABASE_URL`、公开的 `SUPABASE_KEY` 和 `AUTH_REDIRECT_URL`，未使用 `.env` 配置。

自建云端需要替换这些配置，并提供 `notes` / `tasks` 表以及 `sync_upsert_note` / `sync_upsert_task` RPC，配置用户数据隔离的 RLS 策略和 Auth 回调地址。**仓库尚未包含云端 schema、RPC 定义或迁移脚本**，因此仅部署前端不能完整复现独立的同步服务。浏览器端只能使用公开密钥，不能使用服务端密钥。

当前测试阶段的邮件发送限制见 [RELEASE.md](./RELEASE.md#current-beta-limitation)。

## 工程结构

```text
index.html          页面结构
main.js             Vite 入口
app.js              业务逻辑、IndexedDB 数据层、本地同步队列
cloud.js            Supabase Auth 与云同步
auth-status.js      账号状态提示
recovery-ui.js      密码恢复界面辅助
icons.js            本地图标运行时
styles.css          主界面样式
cloud.css           账号与同步样式
fonts/              本地日期数字字体
public/             PWA / Android 共用静态图标
tests/              本地数据、交互与云同步回归测试
.github/workflows/  Android debug / release 构建
scripts/            Android release 辅助脚本
vite.config.js      Web / PWA 构建配置
capacitor.config.json
```

## 本地开发

使用 Node.js 22 或更高版本（与 `package.json` 和 CI 一致）。

```bash
npm ci
npm run dev
```

本地回归测试（Node.js 内置测试运行器 + jsdom / fake-indexeddb）：

```bash
npm test
```

覆盖输入模式与命令解析、删除撤销、保存失败与草稿保护、并发写入、备份合并、schema 升级、首页索引读取，以及云同步分页、上传确认、账号切换和同步中的并发修改。云端测试使用模拟接口，不代替真实账号与跨设备验证。

生产构建：

```bash
npm run build
npm run preview
```

构建产物位于 `dist/`，Vercel 与 Capacitor 都使用这份 Web bundle。PWA 的 Service Worker 在生产构建中生成，可用 `preview` 验证；需先联网加载并完成资源缓存，之后才能离线打开。

## Android

本地构建需准备 Android Studio、JDK 21 和 Android SDK 36（CI 使用 Build Tools 36.0.0）。仓库不包含生成的 `android/` 工程，首次创建：

```bash
npm ci
npm run build
npm run android:add
```

后续同步 Web bundle：

```bash
npm run android:sync
```

使用 Android Studio 打开：

```bash
npm run android:open
```

GitHub Actions 会在 `main` 更新、PR 或手动触发时构建 debug APK。正式发布工作流通过手动输入版本号构建签名 APK / AAB，执行签名验证和 SHA-256 校验，并创建附带安装包和校验文件的 GitHub Release。详细说明见 [`RELEASE.md`](./RELEASE.md)。

## 部署

项目已经是独立仓库，Vercel 应直接以仓库根目录作为 Root Directory：

```text
Repository: chivopic/today-workspace
Branch:     main
Root:       ./
Build:      npm run build
Output:     dist
```

## Roadmap

- [ ] 跨同步轮次持久化游标的增量 pull（已有单轮分页）
- [ ] 更明确的多设备冲突策略
- [ ] 同步失败的自动退避重试与更细的错误诊断（已有基础状态提示）
- [ ] 任务日期与提醒
- [ ] 系统分享入口等原生能力
- [ ] 浏览器端到端测试与真实多设备同步验证
- [ ] 完善 Android 真机发布验证与人工维护的 changelog（已有签名发布流程）

## 远期探索（尚未实现）

- [ ] Workspace search assistant
- [ ] Semantic search
- [ ] AI task extraction
- [ ] Knowledge graph
- [ ] Personal second brain integration

---

Today Workspace is intentionally small: fast to open, easy to understand, and dependable when the network is not.
