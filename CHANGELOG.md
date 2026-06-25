# Changelog

All notable changes to Bemby are documented here.

---

## v0.9.23

### 中文

- **内置 Telegram 消息客户端全面升级** -- 消息客户端现已支持表情回应、引用回复、内联图片查看、频道帖子评论/线程，以及机器人命令自动补全，并自动将已读消息标记为已读
- **表情回应** -- 将鼠标悬停在任意消息上，点击笑脸图标可选择表情；提供 👍 ❤️ 😂 😮 😢 👎 🔥 🎉 八个快捷表情；可再次点击取消已有回应；自己的回应会以高亮样式显示
- **引用回复** -- 将鼠标悬停在消息上，点击回复图标即可引用；消息框顶部显示引用预览；点击引用消息可滚动至原始消息；发送后原始引用关系在 Telegram 中完整保留
- **内联图片查看** -- 含图片的消息直接在聊天气泡中展示缩略图，无需跳转外部链接
- **频道帖子评论** -- 在带评论计数的频道消息下点击评论按钮，可在右侧面板中查看并回复评论线程
- **机器人命令自动补全** -- 与机器人对话时，输入框左侧出现 `/` 按钮，点击可展开命令列表；在输入框中输入 `/` 后也会自动弹出命令面板，每条命令附带说明；通过方向键或 Tab/Enter 选择，Escape 关闭
- **自动标记已读** -- 打开聊天窗口或收到新消息时，自动调用 Telegram API 标记消息已读，并清除对话列表中的未读角标
- **导航栏重新排序并添加图标** -- 导航菜单调整为：账户、消息、任务、模板、日志、设置、帮助；各菜单项均已添加 FontAwesome 图标

### English

- **Telegram Messenger major upgrade** -- the built-in messenger now supports emoji reactions, quoted replies, inline photo viewing, channel post comment threads, bot command autocomplete, and auto read-marking
- **Emoji reactions** -- hover any message and click the smiley icon to react; eight quick-pick emojis (👍 ❤️ 😂 😮 😢 👎 🔥 🎉) plus a full picker; tap your own reaction to remove it; your reactions are highlighted
- **Quoted replies** -- hover a message and click the reply icon to quote it; a preview strip appears above the compose box; click any reply quote to scroll to the original; the reply relationship is preserved on Telegram
- **Inline photo viewing** -- messages containing photos display the image directly inside the chat bubble
- **Channel post comments** -- click the comment count button on any channel post to open the thread panel and reply to comments
- **Bot command autocomplete** -- a `/` button appears beside the compose box when chatting with a bot; typing `/` in the input also opens the panel, showing each command with its description; navigate with arrow keys or Tab/Enter; Escape closes the panel
- **Auto read-marking** -- opening a chat or receiving a new message calls the Telegram API to mark messages as read and clears the unread badge on the dialog
- **Navigation reorder with icons** -- menu order is now: Accounts, Messages, Jobs, Templates, Logs, Settings, Help; each item has a FontAwesome icon

---

## v0.9.21

### 中文

- **代理支持扩展** -- 代理设置现已适用于所有任务类型（签到、自定义、Emby 观看）；可在模板中为任意类型设置代理，HTTP 代理用于 Emby 请求，SOCKS5 代理用于 Telegram 连接
- **修复 Emby 容器连接问题** -- 修复在 Docker 容器中 Emby 观看任务无法连接服务器的问题；无代理时恢复使用 Node.js 原生 fetch，避免 undici 在容器环境中的 TLS 兼容性问题

### English

- **Proxy support extended** -- proxy settings now apply to all job types (checkin, custom, Emby Watch); set a proxy on any template type, with HTTP proxies used for Emby requests and SOCKS5 proxies for Telegram connections
- **Fix Emby container connectivity** -- fixed Emby Watch jobs failing to reach the server when running in a Docker container; non-proxy requests now use Node.js native fetch instead of undici to avoid TLS compatibility differences in containerised environments

---

## v0.9.20

### 中文

- **批量操作** -- 任务和模板列表支持批量启用、禁用和删除；禁用和删除操作均有确认弹窗
- **禁用模板隐藏** -- 已禁用的模板不再出现在任务的模板下拉列表中；已绑定该模板的任务不受影响
- **Emby 错误信息增强** -- Emby 观看任务失败时，错误信息不再仅显示"fetch failed"，而是包含完整请求 URL 及底层原因（如 ECONNREFUSED）；HTTP 错误则显示状态码和 Emby 返回的错误正文
- **日志文本搜索** -- 日志页面新增文本搜索框，可对已加载的日志按任务名称、账号名称或消息内容进行模糊筛选；搜索状态在刷新后自动恢复

### English

- **Bulk actions** -- jobs and templates lists now support bulk enable, disable, and delete; disable and delete show confirmation modals
- **Disabled templates hidden** -- disabled templates no longer appear in the job template dropdown; jobs already linked to a disabled template are unaffected
- **Emby error enrichment** -- Emby Watch failures now show the full request URL and underlying cause (e.g. ECONNREFUSED) instead of "fetch failed"; HTTP errors include the status code and Emby's error body
- **Log text search** -- a search input in the Logs header filters loaded rows by job name, account name, or message; filter state persists across page refreshes

---

## v0.9.19

### 中文

- **模板单元测试** -- 新增模板 CRUD、模板同步至关联任务、删除级联、模板绑定与解绑、embywatch 配置锁例外以及运行时配置合并的后端单元测试

### English

- **Template unit tests** -- added backend unit tests covering template CRUD, sync to linked jobs, delete cascade, applying and removing templates, embywatch config-lock exception, and runtime config merge in the runner

---

## v0.9.18

### 中文

- **模板批量分享** — 在模板列表中勾选多行，点击页头的**分享所选 (N)** 按钮，将所有选中模板以 JSON 数组形式复制至剪贴板；导入也同时支持单个对象和数组
- **日志归档** — 点击日志行上的归档图标可软隐藏该记录（不删除数据）；归档记录默认隐藏，可通过**显示已移除**开关切换可见性；点击还原图标取消归档
- **禁用确认弹窗** — 在任务列表中点击启用状态标签禁用任务时，会弹出确认对话框；重新启用无需确认
- **下次运行面板排序** — 首页"下次运行"面板现按执行时间先后排序
- **默认时间窗口** — 新建任务的默认时间窗口调整为 10:00–22:00
- **设置页面布局优化** — 设置卡片改为自适应网格排列，减少空白浪费

### English

- **Multi-template share** — tick checkboxes on any template rows and click **Share Selected (N)** in the header to copy all selected templates as a JSON array to the clipboard; import now accepts both a single JSON object and an array
- **Log retirement** — click the archive icon on any non-running log row to soft-hide it without deleting data; archived records are hidden by default and revealed by the **Show Retired** toggle; click the restore icon to un-archive
- **Disable confirmation** — clicking the enabled badge on a job row to disable it now shows a confirmation modal; re-enabling is still immediate
- **Next-run panel sorting** — the "Next Scheduled" panel on the dashboard now sorts runs by time ascending
- **Default schedule window** — new jobs now default to a 10:00–22:00 window
- **Settings layout** — settings cards now flow in an adaptive grid, reducing wasted whitespace

---

## v0.9.17

### 中文

- **API 密钥脱敏** — AI 服务商 API 密钥在设置页面仅显示首尾各 4 位（如 `sk-a****1234`），防止密钥泄露

### English

- **API key masking** — AI supplier API keys are now masked in the Settings UI, showing only the first and last 4 characters (e.g. `sk-a****1234`) to prevent accidental key exposure
