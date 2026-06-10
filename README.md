# Bemby v0.8.0

[English](#english) | **简体中文**

> 如果 Bemby 为你节省了时间，欢迎在 GitHub 上给它点个 Star，帮助更多人发现这个项目。

一款自托管的自动化工具，用于管理每日 Telegram 机器人签到和 Emby 视频观看会话。内置 Web 管理门户，支持多账号和多任务管理。

![Bemby 管理面板](docs/screenshot.png)

---

## 功能特性

- **多账号** — 管理多个 Telegram 账号，每个账号通过 MTProto 独立认证
- **两种任务类型**
  - **签到** — 在随机的每日时间发送 `/start` 给 Telegram 机器人并点击回复按钮
  - **Emby 观看** — 模拟 SenPlayer 在 Emby 服务器上的会话，定期上报播放进度
- **调度器** — 在每个任务可配置的每日时间窗口内随机选取执行时间；失败时自动重试
- **Web 管理门户** — Vue 3 单页应用，用于管理账号、任务、设置和查看日志
- **持久化存储** — SQLite 数据库，重启和容器升级后数据不丢失

---

## 环境要求

- Docker

---

## 快速开始

```bash
docker run -d \
  --name bemby \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /docker/bemby-data:/app/data \
  -e PORT=3000 \
  -e DB_PATH=/app/data/bemby.db \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=changeme \
  -e JWT_SECRET=change-me-in-production \
  -e TZ=Australia/Sydney \
  liveinaus/bemby:latest
```

---

## 初次使用

### 1. 添加 Telegram 账号（签到任务需要）

1. 进入 **账号** 页面，点击 **添加账号**
2. 填写显示名称、手机号、API ID 和 API Hash
   - 从 [my.telegram.org/apps](https://my.telegram.org/apps) 获取 API ID/Hash
3. 点击 **请求验证码** — Telegram 将向该账号手机发送登录验证码
4. 点击 **验证** 并输入验证码（如已开启两步验证，还需输入密码）
5. 账号状态变为 **已认证**

### 2. 创建任务

进入 **任务** 页面，点击 **添加任务**，配置以下内容：

| 字段                    | 说明                                                              |
|-------------------------|-------------------------------------------------------------------|
| 任务名称                | 任务的显示名称                                                     |
| 任务类型                | `签到` 或 `Emby 观看`                                             |
| 账号                    | 已认证的 Telegram 账号（仅签到任务）                               |
| 机器人用户名            | Telegram 机器人 handle，可带或不带 `@`（仅签到任务）              |
| 服务器地址              | Emby 服务器地址，如 `https://emby.example.com:443`（仅 Emby 观看）|
| Emby 用户名/密码        | Emby 账号凭证（仅 Emby 观看）                                     |
| 时间窗口开始/结束        | 每日执行时间窗口，格式 HHMM，如 `1400`–`1600`                    |
| 最大重试次数            | 失败时的重试次数                                                   |

调度器每天在时间窗口内随机选取执行时间。若保存任务时当日窗口已过，则顺延至次日。

### 3. 系统设置

进入 **设置** 页面可配置：

- **默认时区** — 用于所有任务的调度时间窗口
- **默认最大重试次数**
- **每日只执行一次** — 测试时可关闭此选项，使任务当日可重复执行
- **Emby 观看默认值** — 播放时长、设备名称和 User Agent（已预配置 SenPlayer/Mac 默认值）
- **管理员凭证** — 修改管理员用户名或密码

---

## 本地开发

**所需工具：** Node.js 20+、Git

```bash
git clone https://github.com/liveinaus/Bemby.git
cd Bemby
./dev.sh
```

首次运行时，`dev.sh` 会将 `env.example` 复制为 `backend/.env`，并在占位符值未修改时发出警告。

| 服务     | 默认地址                      |
|----------|-------------------------------|
| 前端     | http://localhost:5173         |
| 后端     | http://localhost:3000         |

使用 `backend/.env` 中配置的账号登录（默认 `admin` / `changeme`）。

---

## 项目结构

```
bemby/
├── backend/
│   └── src/
│       ├── server.ts          -- Express 入口
│       ├── scheduler.ts       -- 基于 setTimeout 的任务调度器
│       ├── db/
│       │   └── database.ts    -- SQLite 初始化和迁移
│       ├── jobs/
│       │   ├── runner.ts      -- 任务分发与重试
│       │   ├── checkin.ts     -- Telegram MTProto 签到逻辑
│       │   └── embywatch.ts   -- Emby 播放模拟
│       ├── routes/
│       │   ├── auth.ts        -- 登录、JWT、凭证管理
│       │   ├── accounts.ts    -- Telegram 账号 CRUD 及认证流程
│       │   ├── jobs.ts        -- 任务 CRUD 及手动触发
│       │   ├── logs.ts        -- 任务执行日志查询
│       │   ├── settings.ts    -- 系统设置键值存储
│       │   └── status.ts      -- 调度器下次执行状态
│       └── types.ts
├── frontend/
│   └── src/
│       ├── views/
│       │   ├── AccountsView.vue
│       │   ├── JobsView.vue
│       │   ├── LogsView.vue
│       │   ├── SettingsView.vue
│       │   └── HelpView.vue
│       ├── api/client.ts      -- Axios API 客户端及类型
│       └── router/index.ts
├── docker-compose.yml
├── Dockerfile
├── dev.sh                     -- 本地开发启动脚本（后端 + 前端）
└── env.example
```

---

## 调度器工作原理

1. 启动时（以及任务创建/更新/删除后），`refreshScheduler()` 重新运行
2. 对每个已启用的任务调用 `pickNextRun()`：
   - 当前时间在窗口**之前** → 在今日完整窗口内随机安排
   - 当前时间在窗口**之内** → 在今日剩余窗口时间内随机安排
   - 窗口已**过去**（或任务今日已执行且开启了"每日只执行一次"）→ 安排在明日窗口内执行
3. `setTimeout` 在指定时间触发并执行任务
4. 执行完成（无论成功或失败）后立即为次日重新调度
5. 后台每 5 分钟轮询一次，补偿停机期间遗漏的任务

---

## Emby 观看详情

Emby 观看任务以真实 Emby 用户身份认证，模拟 macOS 上的 SenPlayer 6.1.0 会话：

- 从媒体库中随机选取一部电影或剧集
- 上报播放开始（`POST /Sessions/Playing`）
- 每 30 秒发送进度更新（`POST /Sessions/Playing/Progress`）
- 在配置的时长后上报会话结束（`POST /Sessions/Playing/Stopped`）

Emby 服务器将该会话识别为 **Mac / SenPlayer**，与真实 macOS 客户端一致。

---

## 贡献

欢迎贡献代码。开始之前：

1. Fork 仓库并创建功能分支
2. 修改代码 — 遵循现有代码风格（TypeScript strict、Vue 3 Composition API）
3. 使用 `./dev.sh` 在本地测试
4. 提交 Pull Request，清晰描述修改内容和原因

请保持 Pull Request 聚焦。欢迎提交 Bug 修复、稳定性改进、新任务类型和界面优化。如果计划进行较大改动，请先提 Issue 讨论方案。

---

## 免责声明

Bemby 仅供个人自动化和学习目的使用。请负责任地使用，并遵守所交互平台（Telegram、Emby 等）的服务条款。

对于因使用本软件而导致的账号封禁、数据丢失、服务中断或任何其他后果，作者不承担任何责任。使用风险由您自行承担。

---

## 许可证

版权所有 (c) 2024 Bemby contributors

特此免费授予任何人获取本软件副本并使用、复制、修改、分发的权利，须遵守以下条件：

- **署名** — 任何分发的副本或衍生作品，无论是否修改，必须清晰注明原始来源（提供本仓库链接即可）。
- 以上版权声明和本许可声明须包含在软件的所有副本或主要部分中。

本软件按"原样"提供，不附带任何形式的保证。在任何情况下，作者均不对因使用本软件而产生的任何索赔、损害或其他责任负责。

---

<a name="english"></a>

## English

[简体中文](#bemby-v080) | **English**

> If Bemby saves you time, please consider giving it a star on GitHub. It helps others find the project and keeps development going.

A self-hosted automation tool for managing daily Telegram bot check-ins (签到) and Emby video-watch sessions. Includes a web admin portal for managing multiple accounts and jobs.

![Bemby admin panel](docs/screenshot.png)

---

### Features

- **Multi-account** — manage multiple Telegram accounts, each independently authenticated via MTProto
- **Two job types**
  - **Check-in (签到)** — sends `/start` to a Telegram bot and clicks the reply button on a randomised daily schedule
  - **Emby Watch** — simulates a SenPlayer session on an Emby server, reporting playback progress at regular intervals
- **Scheduler** — picks a random time within a configurable daily window per job; handles retry on failure
- **Web admin portal** — Vue 3 SPA for managing accounts, jobs, settings, and viewing logs
- **Persistent storage** — SQLite database, survives restarts and container upgrades

---

### Requirements

- Docker

---

### Quick Start

```bash
docker run -d \
  --name bemby \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /docker/bemby-data:/app/data \
  -e PORT=3000 \
  -e DB_PATH=/app/data/bemby.db \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=changeme \
  -e JWT_SECRET=change-me-in-production \
  -e TZ=Australia/Sydney \
  liveinaus/bemby:latest
```

---

### First-time setup

#### 1. Add a Telegram account (for check-in jobs)

1. Go to **Accounts** and click **Add Account**
2. Enter a display name, phone number, API ID, and API Hash
   - Get API ID/Hash from [my.telegram.org/apps](https://my.telegram.org/apps)
3. Click **Request Code** — Telegram sends a login code to the account's phone
4. Click **Verify** and enter the code (and 2FA password if enabled)
5. Status changes to **Authenticated**

#### 2. Create a job

Go to **Jobs** and click **Add Job**. Configure:

| Field              | Description                                                      |
|--------------------|------------------------------------------------------------------|
| Job Name           | Display name for the job                                         |
| Job Type           | `Check-in` or `Emby Watch`                                       |
| Account            | Authenticated Telegram account (check-in only)                   |
| Bot Username       | Telegram bot handle, with or without `@` (check-in only)         |
| Server URL         | Emby server address, e.g. `https://emby.example.com:443` (Emby Watch only) |
| Emby Username/Password | Emby account credentials (Emby Watch only)                  |
| Window Start/End   | Daily schedule window in HHMM format, e.g. `1400`-`1600`        |
| Max Retries        | Number of retry attempts on failure                              |

The scheduler picks a random time within the window each day. If the window has already passed when the job is saved, it schedules for the following day.

#### 3. System settings

Go to **Settings** to configure:

- **Default timezone** — used for all job schedule windows
- **Default max retries**
- **Enforce one run per day** — disable this when testing so jobs can re-run even if they already ran today
- **Emby Watch defaults** — play duration, device name, and user agent (SenPlayer/Mac defaults pre-configured)
- **Admin credentials** — change the admin username or password

---

### Local development

**Requirements:** Node.js 20+, Git

```bash
git clone https://github.com/liveinaus/Bemby.git
cd Bemby
./dev.sh
```

On first run `dev.sh` copies `env.example` to `backend/.env` and warns if placeholder values are still set.

| Service  | Default URL                  |
|----------|------------------------------|
| Frontend | http://localhost:5173        |
| Backend  | http://localhost:3000        |

Log in with the credentials configured in `backend/.env` (default `admin` / `changeme`).

---

### Project structure

```
bemby/
├── backend/
│   └── src/
│       ├── server.ts          -- Express entry point
│       ├── scheduler.ts       -- Per-job setTimeout scheduler
│       ├── db/
│       │   └── database.ts    -- SQLite setup and migrations
│       ├── jobs/
│       │   ├── runner.ts      -- Job dispatcher with retry
│       │   ├── checkin.ts     -- Telegram MTProto check-in logic
│       │   └── embywatch.ts   -- Emby playback simulation
│       ├── routes/
│       │   ├── auth.ts        -- Login, JWT, credential management
│       │   ├── accounts.ts    -- Telegram account CRUD and auth flow
│       │   ├── jobs.ts        -- Job CRUD and manual trigger
│       │   ├── logs.ts        -- Job execution log queries
│       │   ├── settings.ts    -- System settings key/value store
│       │   └── status.ts      -- Scheduler next-run status
│       └── types.ts
├── frontend/
│   └── src/
│       ├── views/
│       │   ├── AccountsView.vue
│       │   ├── JobsView.vue
│       │   ├── LogsView.vue
│       │   ├── SettingsView.vue
│       │   └── HelpView.vue
│       ├── api/client.ts      -- Axios API client and types
│       └── router/index.ts
├── docker-compose.yml
├── Dockerfile
├── dev.sh                     -- Local dev launcher (backend + frontend)
└── env.example
```

---

### How the scheduler works

1. On startup (and after any job create/update/delete), `refreshScheduler()` runs
2. For each enabled job it calls `pickNextRun()`:
   - If the current time is **before** the window -> schedules randomly within the full window today
   - If the current time is **inside** the window -> schedules randomly within the remaining window time today
   - If the window has **passed** (or the job already ran today and *Enforce one run per day* is on) -> schedules within the window tomorrow
3. A `setTimeout` fires at the chosen time and executes the job
4. On completion (success or failure) the job is immediately rescheduled for the next day
5. A background poll runs every 5 minutes to catch any jobs missed during downtime

---

### Emby Watch details

The Emby Watch job authenticates as a real Emby user and simulates a SenPlayer 6.1.0 session on macOS:

- Picks a random movie or episode from the library
- Reports playback started (`POST /Sessions/Playing`)
- Sends progress updates every 30 seconds (`POST /Sessions/Playing/Progress`)
- Reports the session as stopped after the configured duration (`POST /Sessions/Playing/Stopped`)

The Emby server sees the session as **Mac / SenPlayer**, matching a real macOS client.

---

### Contributing

Contributions are welcome. To get started:

1. Fork the repository and create a feature branch
2. Make your changes — follow the existing code style (TypeScript strict, Vue 3 Composition API)
3. Test locally with `./dev.sh`
4. Open a pull request with a clear description of what changed and why

Please keep pull requests focused. Bug fixes, reliability improvements, new job types, and UI polish are all appreciated. If you are planning a larger change, open an issue first to discuss the approach.

---

### Disclaimer

Bemby is provided for personal automation and educational purposes only. Use it responsibly and in accordance with the terms of service of any platform you interact with (Telegram, Emby, etc.).

The authors accept no liability for account suspension, data loss, service disruption, or any other consequence arising from the use of this software. You run it at your own risk.

---

### Licence

Copyright (c) 2024 Bemby contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software to use, copy, modify, and distribute it, subject to the following conditions:

- **Attribution** — any distributed copy or derivative work, whether modified or unmodified, must clearly state the original source (a link to this repository is sufficient).
- The above copyright notice and this permission notice must be included in all copies or substantial portions of the software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY ARISING FROM THE USE OF THE SOFTWARE.
