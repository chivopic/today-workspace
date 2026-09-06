# Today Workspace

一个克制、本地优先、手机端优先的个人工作台。当前同时面向 Web/PWA 与 Android 原生壳：同一套前端通过 Vite 构建，Web 部署到 Vercel，Android 使用 Capacitor 打包。

线上地址：<https://today-workspace.vercel.app>

> 项目于 2026-09-06 从 `chivopic/my-software` 中独立出来长期维护。迁移前的历史仍可在原仓库 Git 历史中查看。

## 当前功能

- `今天 / 记录 / 任务` 三入口底部导航
- 快速记录：普通文本保存为记录，`/task ...` 保存为任务
- 记录搜索、编辑和删除
- 任务创建、完成、删除和筛选
- IndexedDB 本地持久化
- Notes / Tasks 同步就绪数据模型：`userId / deviceId / version / deletedAt / syncStatus`
- 本地 `outbox` 变更队列
- 删除采用 tombstone 软删除，保留跨设备删除语义
- JSON 数据导出 / 导入；备份 v2 保留同步元数据，并兼容旧 v1 备份
- Supabase 账号、云同步与密码恢复
- Vite PWA 构建与 Workbox 离线缓存
- 深色模式
- 192×192 / 512×512 PNG 安装图标
- Lucide 通用图标子集内置，不依赖第三方运行时 CDN
- Capacitor Android 配置，应用 ID 为 `io.chivopic.today`
- GitHub Actions 自动构建 Android debug APK，并支持签名 Release APK/AAB

## 工程结构

```text
index.html        页面结构
main.js           Vite 入口
app.js            业务逻辑、IndexedDB 数据层和本地同步队列
cloud.js          Supabase 账号与云同步
icons.js          本地图标运行时
styles.css        样式
public/           PWA / Android 共用静态图标
scripts/          Android release 辅助脚本
vite.config.js    Web/PWA 构建配置
capacitor.config.json
```

## 本地开发

Capacitor 8 要求 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
npm run preview
```

构建产物位于 `dist/`，Vercel 和 Capacitor 都使用这份 Web bundle。

## Android

首次在本地创建 Android 工程：

```bash
npm install
npm run build
npm run android:add
```

后续同步 Web 代码：

```bash
npm run android:sync
```

使用 Android Studio 打开：

```bash
npm run android:open
```

GitHub Actions 会在相关 PR 和 `main` 更新时构建 Android debug APK；Release workflow 可手动构建签名 APK/AAB。CI 使用 Node 22、JDK 21 和 Android SDK 36。

## 部署

该仓库现在就是独立项目根目录。Vercel 项目不再需要设置 `today-workspace` Root Directory，直接从仓库根目录执行 Vite 构建即可。

## 数据策略

Today Workspace 保持 local-first：记录和任务首先写入当前设备的 IndexedDB，不等待网络。数据库继续沿用旧 key `test1-workspace`，避免升级后看不到已有本地数据。

IndexedDB schema 当前为 v2，包含三个 object store：

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

每次新建、编辑、完成任务或删除时，实体更新和 outbox 入队在同一个 IndexedDB transaction 中完成。删除写入 `deletedAt` tombstone。云同步使用 Supabase，在登录后将本地 outbox 推送到云端并拉取远端 Notes / Tasks；未登录或离线时仍可完全本地使用。

## 下一阶段

1. 完善增量 pull / cursor 与冲突策略
2. 强化同步状态、失败重试与多设备测试
3. 增加任务日期、通知、系统分享入口等原生能力
4. 完善正式 Android Release 流程与版本发布
5. 逐步补充自动化测试和公开项目文档
