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

**在线体验：** https://today-workspace.vercel.app

项目最初在 `chivopic/my-software` 中孵化，并于 2026-09-06 独立为长期维护仓库。迁移前的提交历史仍保留在原仓库中。

## 界面预览

<p align="center">
  <img src="./docs/screenshots/today-light.svg" width="360" alt="Today Workspace 首页浅色模式" />
  &nbsp;&nbsp;
  <img src="./docs/screenshots/settings-dark.svg" width="360" alt="Today Workspace 设置页深色模式" />
</p>

<p align="center"><sub>示例内容仅用于展示；预览按当前项目的布局与视觉样式绘制。</sub></p>

## Design Philosophy

**Capture first. Sync everywhere. Own your data.**

- **Capture first** — 普通文本直接成为记录；输入 `/task ...` 直接成为任务，先记下来，再整理
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
| Instant Capture | 首页直接捕获想法；`/task` 快速创建任务；搜索、编辑、删除记录 |
| Task Management | 创建、完成、删除、状态筛选 |
| Cross-device Sync | Supabase Auth + Notes / Tasks 双向同步；tombstone 软删除保留跨设备删除语义 |
| Offline Support | IndexedDB 本地持久化；本地 `outbox` 保存待同步修改；写入不等待网络 |
| Data Backup | JSON v2 导出 / 导入，并兼容旧 v1 备份 |

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

Today Workspace 把“本地可用”当作默认状态，而不是降级模式。当前数据库沿用历史 key `test1-workspace`，避免升级后已有设备上的本地数据“消失”。Schema v2 包含：

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

## 工程结构

```text
index.html          页面结构
main.js             Vite 入口
app.js              业务逻辑、IndexedDB 数据层、本地同步队列
cloud.js            Supabase Auth 与云同步
icons.js            本地图标运行时
styles.css          主界面样式
cloud.css           账号与同步样式
public/             PWA / Android 共用静态图标
scripts/            Android release 辅助脚本
vite.config.js      Web / PWA 构建配置
capacitor.config.json
```

## 本地开发

Capacitor 8 要求 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

本地回归测试（Node.js 内置测试运行器 + jsdom / fake-indexeddb）：

```bash
npm test
```

覆盖输入解析、并发写入与删除、备份合并、搜索防抖及可见页面读取次数。

生产构建：

```bash
npm run build
npm run preview
```

构建产物位于 `dist/`，Vercel 与 Capacitor 都使用这份 Web bundle。

## Android

首次创建 Android 工程：

```bash
npm install
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

GitHub Actions 会在 `main` 更新与相关 PR 中构建 debug APK。正式发布流程可手动构建签名 APK / AAB，并执行签名验证和 SHA-256 校验。详细说明见 [`RELEASE.md`](./RELEASE.md)。

## 部署

项目已经是独立仓库，Vercel 应直接以仓库根目录作为 Root Directory：

```text
Repository: chivopic/today-workspace
Branch:     main
Root:       ./
```

## Roadmap

- [ ] 增量 pull / cursor
- [ ] 更明确的多设备冲突策略
- [ ] 同步失败重试与状态可视化
- [ ] 任务日期与提醒
- [ ] 系统分享入口等原生能力
- [ ] 更完整的自动化测试
- [ ] 正式 Android 版本发布与 changelog

## Future

- [ ] Workspace search assistant
- [ ] Semantic search
- [ ] AI task extraction
- [ ] Knowledge graph
- [ ] Personal second brain integration

---

Today Workspace is intentionally small: fast to open, easy to understand, and dependable when the network is not.
