# Today Workspace

无需账号即可记录想法和任务，离线继续使用，登录后跨设备同步。

[![Android CI](https://github.com/chivopic/today-workspace/actions/workflows/today-workspace-android.yml/badge.svg)](https://github.com/chivopic/today-workspace/actions/workflows/today-workspace-android.yml)

[在线体验](https://today-workspace.vercel.app) · [Android 下载](https://github.com/chivopic/today-workspace/releases) · [快速上手](#快速上手) · [English](./README.md)

一个用来记下想法与下一步行动的个人笔记本，当前界面为中文。可在浏览器中使用、安装为 PWA，或在 Android 上运行同一套应用。当前源码版本：**0.4.0**。

## 界面预览

![Today Workspace 桌面界面：横线笔记本布局、快速记录、待办和最近记录](./docs/screenshots/desktop-light.jpg)

| 移动端 · 浅色 | 移动端 · 深色 |
| --- | --- |
| ![窄屏下的浅色今天页面](./docs/screenshots/mobile-light.jpg) | ![窄屏下的深色今天页面](./docs/screenshots/mobile-dark.jpg) |

以上为 v0.4.0 在未登录状态下的真实浏览器截图，使用示例记录与任务。移动端图片展示响应式 Web 页面，并非 Android 真机截图。见[截图说明](./docs/development.md#screenshots)。

## 为什么使用它？

- **先记下来，无需先配置。** 直接保存记录，切换到任务模式，或输入 `/task 买牛奶`。本地使用不需要账号。
- **断网时继续写。** 记录和任务写入 IndexedDB，待同步修改保存在本地队列。保存失败时保留输入并显示错误。
- **看到下一步要做什么。** 首页最多显示 4 条待办和 4 条最近记录；可搜索记录、筛选任务，并在 6 秒内撤销最近一次删除。
- **带走自己的备份。** 记录与任务可导出为 JSON；导入时合并较新的内容，不先清空已有数据。

可选的邮箱登录提供跨设备同步、待同步数量与手动同步。目前同一浏览器配置和站点来源的本地数据仅绑定一个账号，详见[同步行为与限制](./docs/architecture.md#sync-behavior)。

## 快速上手

需要 **Node.js 22.12+**、npm，以及启用 IndexedDB 的浏览器。安装依赖需要联网。

```bash
git clone https://github.com/chivopic/today-workspace.git
cd today-workspace
npm ci
npm run dev
```

打开 Vite 打印的本地地址，通常为 `http://localhost:5173`。你应看到“今天”、输入框，以及初始示例记录和任务。输入 `试试更精简的每日计划` 并回车，刷新后这条记录应仍然存在。

**这条本地使用路径不需要 `.env` 文件或账号。** 源码目前包含托管服务的公开云端配置。如需连接自己的后端，请先阅读[云端配置](./docs/architecture.md#cloud-configuration)：仓库尚未包含数据库 schema 和 RPC 迁移脚本。

## 试试这三个流程

### 先记录，再找回

在“今天”保持“记录”模式，输入：

```text
想法：把会议决定和下一步行动放在一起。
```

进入“记录”，搜索 `会议`。点击记录可编辑，或用“新建”写一条更长的内容。

### 把想法变成任务

在首页输入以下内容，即使当前选中“记录”模式也可以：

```text
/task 检查发布清单
```

`/task` 后的文字会成为待办。勾选完成后，可在“任务 → 已完成”中找到它。只输入 `/task` 而没有内容，不会创建任务。

### 更换浏览器前备份

打开“设置 → 导出 JSON”，在目标浏览器中用“导入 JSON”合并备份。支持 v2 和旧版 v1 备份，较新的本地版本会保留。

本地数据属于当前浏览器配置和站点来源。更换主机或端口会使用不同的本地存储，清除站点数据会删除这些内容；迁移或清理前请先导出。

## 工作方式

```text
记录 / 编辑 / 完成 / 删除
            |
            v
     IndexedDB 事务
     +--------------------+
     | 实体记录 + outbox  |----> 渲染已保存的本地状态
     +--------------------+
            |
       联网且已登录
            v
      上传待同步修改
            |
            v
     Supabase -> 分页拉取 -> 合并到 IndexedDB
```

界面等待本地写入，不等待网络。同步在本地修改、登录、恢复联网及回到页面时触发，没有实时订阅。每轮同步仍扫描远端分页数据，尚未仅拉取上次同步后的变化。

PWA 在生产构建成功联网加载后缓存应用。离线重新打开依赖该缓存，应使用[生产预览](./docs/development.md#build-and-preview)验证，而不只是开发服务器。

## 文档

| 文档 | 内容 |
| --- | --- |
| [开发与部署](./docs/development.md) | 测试、构建、工程结构、Android、本地与线上部署、截图、后续计划 |
| [数据与同步](./docs/architecture.md) | Schema、备份、冲突处理、账号绑定、云端配置限制 |
| [Android 发布指南](./RELEASE.md) | 签名、APK / AAB、校验文件、发布验证、测试阶段的邮件限制 |
| [GitHub Releases](https://github.com/chivopic/today-workspace/releases) | 下载和自动生成的发布说明 |

## 贡献与许可证

欢迎提交问题、针对性修复、无障碍改进和文档贡献。[CONTRIBUTING.md](./CONTRIBUTING.md) 说明了环境准备、验证要求、数据安全注意事项和 PR 流程。Issue 和 PR 均可使用中文或英文。

本项目采用 [MIT 许可证](./LICENSE)，第三方组件保留各自的许可条款。

项目最初在 [chivopic/my-software](https://github.com/chivopic/my-software) 中开发，于 2026-09-06 独立为当前仓库。此前的提交历史仍保留在原仓库。
