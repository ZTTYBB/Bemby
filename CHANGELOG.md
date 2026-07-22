# Changelog

All notable changes to Bemby are documented here.

---

## v0.9.34

### 中文

**新功能**

- **通行密钥（Passkey）注册、登录与验证** -- 可为账户添加通行密钥（"添加通行密钥"），整个 WebAuthn 注册流程在服务端完成，无需浏览器操作，每个账户存储一个通行密钥。已持有通行密钥的账户，登录对话框中会出现"使用通行密钥登录"：先以通行密钥登录，随后仅需输入 2FA 密码即可完成。"验证"操作用于确认 Telegram 仍接受已存储的通行密钥。另提供"批量添加通行密钥"，会自动跳过（并顺带验证）已持有 Bemby 通行密钥的账户。（实验性功能）
- **批量重命名** -- "批量重命名" 按名称格式批量重命名所选账户，`{index}` 会替换为递增序号，可配置起始序号与序号位数（补零），并提供实时预览
- **批量获取属性** -- "获取属性" 为所选已认证账户刷新 TG 信息及附加属性（名称、用户名、登录邮箱、通行密钥状态），不执行发消息许可检测
- **批量修改登录邮箱** -- "批量修改登录邮箱" 使用 `+` 标签模板为所选账户设置登录邮箱，模板支持 `{phoneNum}`、`{tgId}`、`{id}` 及随机变量（`{word:4}`、`{alpha:8}`、`{uuid}`）；因 Telegram 拒绝纯数字邮箱标签，数字会映射为字母（0=a … 9=j）。确认码通过 Gmail 应用专用密码经 IMAP 读取（仅用于本次运行，绝不存储），开始前需先"测试登录"
- **批量修改凭据** -- "批量修改凭据" 为所选账户批量设置/轮换 2FA 密码，可选同时"移除其他所有已登录设备"、"移除其他所有通行密钥（保留 Bemby 管理的）"，并可按模板将结果追加至备注
- **额外信息列** -- 账户现可存储更多元信息（登录邮箱、受限状态、通行密钥标记）；新增"显示额外信息 / 隐藏额外信息"切换与"额外信息"列，展示 Bemby 通行密钥、通行密钥、登录邮箱、受限状态等属性
- **批量添加账户（需开启）** -- "批量添加账户" 每行粘贴 `手机号----API网址`，Bemby 先批量创建账户，再逐个认证：请求验证码、从各账户的 API 网页读取验证码与 2FA 密码、按配置的间隔等待后处理下一个（仅填手机号则只创建不认证）。"选项"面板支持逐账户间隔、名称前缀与编号方案、备注模板（`{apiUrl}` 逐账户展开）、候选设备/代理/API ID Hash（逐账户随机选取，可"批量粘贴"多组 API 凭据），以及提取验证码/2FA 的自定义正则。此功能与"批量清理"均需设置环境变量 `BULK_ACCOUNT_MANAGEMENT=1` 才会显示
- **Shift 范围选择** -- 账户表格中可按住 Shift 点击，选中上次点击行与本次点击行之间的连续区间
- **精简账户视图 / 批量操作菜单** -- 账户视图重构为更少的行内按钮，批量操作统一收纳至"批量操作"菜单
- **账户间间隔** -- 各顺序批量操作共用"每个账户之间的间隔（秒）"设置（0 表示不等待），避免触发 Telegram 限流
- **备份包含通行密钥与账户属性** -- 数据导出/导入现随账户一并携带其通行密钥与附加属性；包含通行密钥私钥的备份导出时会强制加密
- **更清晰的认证错误提示** -- 认证流程改为返回具体且已本地化的错误（验证码错误、验证码已过期、操作过于频繁），不再是笼统的失败提示

**修复**

- **修复 Emby 观看自定义 User Agent 未生效** -- Emby 会话的应用名与版本此前无论选择何种 UA 都被硬编码为 `SenPlayer` / `6.1.0`，现从所选 UA 中解析客户端名称与版本，自定义 UA 预设可在 Emby 后台正确显示
- **修复回调按钮点击超时被误判为失败** -- 按钮点击回调触发 `BOT_RESPONSE_TIMEOUT` 时，即便签到实际已生效仍被判为失败。现重新拉取消息，若 `editDate` 已变化则视为机器人已处理点击，不再误报失败
- **修复无法添加通行密钥**
- **修复通行密钥登录标记判断错误** -- 登录对话框此前用了错误的标记（`hasPasskey`，包含非 Bemby 通行密钥），现改用 `hasBembyPasskey`，仅在 Bemby 确实持有私钥时才触发"通行密钥 + 2FA"自动流程
- **修复批量清理按钮文案与层级** -- 批量发消息许可检测按钮误显示为"开始清理"，现更正为"开始检测"，并修正中文文案错别字
- **修复账户视图弹窗样式** -- 提高弹窗遮罩层级，使其位于移动端头部与侧边栏之上（标题不再被遮挡）；弹窗内容过长时可滚动，底部按钮始终固定可点击

### English

**Features**

- **Passkey register, log in, and verify** -- add a passkey to an account (**Add passkey**) via a fully server-side WebAuthn registration ceremony (no browser needed), storing one passkey per account. Accounts holding a passkey get **Log in with passkey** in the auth dialog: it logs in with the passkey and then prompts only for the 2FA password. A **Verify** action confirms Telegram still accepts the stored passkey, and **Bulk Add Passkey** skips (and verifies) accounts that already hold a Bemby passkey. (Experimental)
- **Bulk rename** -- **Bulk Rename** renames selected accounts by a name format where `{index}` becomes a running number, with a configurable start index and index digits (zero-padding) and a live preview
- **Bulk fetch attributes** -- **Fetch Attributes** refreshes TG info and extra attributes (name, username, login email, passkey status) for selected authenticated accounts, without running the send-permission check
- **Bulk change login email** -- **Bulk Change Login Email** sets a login email on selected accounts using a `+`-tag template with variables (`{phoneNum}`, `{tgId}`, `{id}`, and random `{word:4}`, `{alpha:8}`, `{uuid}`); digits are mapped to letters (0=a … 9=j) because Telegram rejects numeric email tags. Codes are read from Gmail over IMAP using a Gmail app password (used only for the run, never stored), with a required **Test login** step first
- **Bulk change credential** -- **Bulk Change Credential** sets/rotates the 2FA password across selected accounts, with optional "remove all other logged-in devices" and "remove all other passkeys (keep Bemby-managed)", plus an append-to-notes-on-success template
- **Extra Info column** -- accounts now store more meta info (login email, restriction status, passkey flags); a new **Show / Hide Extra Info** toggle and **Extra Info** column surface attributes such as Bemby Passkey, Passkey, Login Email, and Restriction
- **Bulk add accounts (opt-in)** -- **Bulk Add** takes one `phone----apiUrl` per line, creating every account first and then authenticating each one sequentially: request the code, read the verification code and 2FA password back from the account's API web page, wait a configurable gap, and move on (a phone-only line creates without authenticating). The **Options** panel adds a per-account gap, a name prefix and numbering scheme, a notes template (`{apiUrl}` expands per account), candidate device/proxy/API ID-Hash pickers (chosen at random per account, with **Bulk paste** for multiple API credential pairs), and custom regexes for extracting the code / 2FA. This feature and **Bulk Clean** are hidden unless `BULK_ACCOUNT_MANAGEMENT=1` is set in the environment
- **Shift-click range selection** -- hold Shift and click in the accounts table to select the contiguous range between the last-clicked row and the shift-clicked row
- **Slimmer account view / Bulk Actions menu** -- the account view was refactored to show fewer inline buttons, with bulk operations consolidated under a **Bulk Actions** menu
- **Gap between accounts** -- a shared "Gap between accounts (seconds)" control (0 = no wait) across the sequential bulk operations avoids Telegram flood limits
- **Backups carry passkeys and account attributes** -- data export/import now carries each account's stored passkey and additional attributes inline; a backup containing a passkey private key is forced to be encrypted on export
- **Clearer auth error messages** -- the auth flow now returns specific, localised errors (invalid verification code, code expired, too many attempts) instead of a generic failure

**Fixes**

- **Fix Emby watch custom User Agent not taking effect** -- the Emby session's app name and version were hardcoded to `SenPlayer` / `6.1.0` regardless of the chosen UA. The client name and version are now parsed from the selected UA, so a custom UA preset shows correctly in the Emby dashboard
- **Fix callback button-click timeout wrongly reported as failure** -- a `BOT_RESPONSE_TIMEOUT` on a button-click callback was treated as a failure even though the check-in often still registered. The job now re-fetches the message and treats a changed `editDate` as proof the bot processed the click, so those runs are no longer reported as failed
- **Fix passkeys could not be added**
- **Fix wrong passkey login flag** -- the auth dialog gated the passkey shortcut on the wrong flag (`hasPasskey`, which includes non-Bemby passkeys); it now uses `hasBembyPasskey`, so the automatic passkey-then-2FA flow triggers only when Bemby actually holds the key
- **Fix bulk clean button label and z-index** -- the bulk send-permission check button incorrectly showed the "Start Cleaning" label; it now reads "Start Check", and a Chinese typo was corrected
- **Fix account view modal style** -- the modal overlay z-index was raised above the mobile header and sidebar (the title is no longer covered), the modal body now scrolls for tall content, and the footer buttons stay pinned to the bottom and reachable

---

## v0.9.33-patch-1

### 中文

- **修复手动执行任务报错（Issue #21）** -- 手动运行任务时，若任务以非 Error 对象拒绝，错误处理代码直接读取 `err.message` 会抛出 `TypeError: Cannot read properties of undefined (reading 'message')`，进而变成未处理的拒绝：日志记录永久卡在"运行中"，真实的失败原因也被掩盖。现所有错误处理统一先规整错误值，任务失败会正确记录为"失败"并显示真实错误信息（调度任务路径存在同样问题，一并修复）
- **修复调度器可能停止执行所有任务** -- 并发槽在写入运行日志之前就被占用，若该写入失败（数据库繁忙、锁、磁盘满等），槽位永不释放；累计到并发上限后调度器彻底卡死，重启前不再执行任何任务。现将槽位纳入 `try/finally`，确保始终释放
- **修复运行中被禁用/删除的任务仍会重新排期** -- 任务运行结束后无条件重新排期，即使它已在运行途中被禁用或删除。现仅在任务仍存在且启用时才重新排期
- **修复登录发送验证码失败时泄漏连接** -- 请求验证码时若 `sendCode` 失败（号码无效/被封、触发限流等），已连接的 Telegram 客户端无人引用且永不销毁。现失败时会销毁该客户端
- **修复导入损坏备份时请求卡死** -- 导入畸形备份文件时事务内抛错会逃逸为未处理拒绝，请求永久无响应。现返回明确的错误提示，且账号导入与模板批量创建改为事务化，中途失败会整体回滚而非留下残缺数据
- **修复编辑使用默认 API 凭据的账号会损坏其 API ID** -- 编辑此类账号（`api_id` 为空）时会把 API ID 写成 `0`。现保留原值

### English

- **Fix manual task run error (issue #21)** -- when a manually-run job rejected with a non-Error value, the error handler read `err.message` directly and threw `TypeError: Cannot read properties of undefined (reading 'message')`, which became an unhandled rejection: the log row stayed stuck in "Running" forever and the real failure cause was masked. All error handling now normalises the error value first, so a failed job is correctly recorded as "Failed" with the real message (the scheduled-run path had the same flaw and was fixed too)
- **Fix scheduler potentially halting all job execution** -- a concurrency slot was acquired before the run-log INSERT, so if that write failed (DB busy, locked, disk full) the slot was never released; once this reached the concurrency cap the scheduler deadlocked and ran no further jobs until restart. Slot handling is now inside a `try/finally` so it is always released
- **Fix disabled/deleted jobs rescheduling themselves mid-run** -- a job was re-armed unconditionally after running, even if it had been disabled or deleted while running. It now reschedules only if the job still exists and is enabled
- **Fix connection leak when requesting a login code fails** -- if `sendCode` failed while requesting a code (invalid/blocked number, flood-wait), the connected Telegram client was orphaned and never destroyed. It is now destroyed on failure
- **Fix request hanging when importing a corrupted backup** -- a throw inside the import transaction escaped as an unhandled rejection and the request never responded. It now returns a clear error, and account import and template bulk-create are transactional so a mid-way failure rolls back rather than leaving partial data
- **Fix editing an account that uses default API credentials corrupting its API ID** -- editing such an account (empty `api_id`) stored the API ID as `0`. The original value is now preserved

---

## v0.9.33

### 中文

**修复**
- **修复模板无法新建（Issue #19）** -- `job_templates` 表的 `run_every_days` 字段迁移（ALTER）被错误地排在建表（CREATE）之前，全新安装首次启动时该迁移因表尚不存在而静默失败，导致建表时缺少此字段，新建模板报错 "table job_templates has no column named run_every_days"，且需重启容器才会自愈。现将该字段直接写入建表语句，并把兼容旧库的迁移移到建表之后，首次启动即正确
- **修复任务失败后卡在"运行中"且无法清除（Issue #18）** -- 升级或重启时若正好有任务在运行，其进程随之消失，但日志记录会永久停留在"运行中"状态：停止按钮找不到对应进程而失败，归档按钮又对运行中记录隐藏，导致该记录既停不掉也删不掉。现启动时会自动将残留的"运行中"记录标记为失败；对进程已不存在的卡住记录，点击停止会将其强制标记为失败以便清理

### English

**Fixes**
- **Fix templates failing to create (issue #19)** -- the `run_every_days` column migration (ALTER) for `job_templates` ran before the table's CREATE, so on a fresh install's first boot the ALTER silently failed (no table yet) and the table was created without the column, breaking template creation with "table job_templates has no column named run_every_days" until the container was restarted. The column is now part of the CREATE statement, and the upgrade-path ALTER moved after it, so it is correct from the first boot
- **Fix tasks stuck in "Running" after a failure, with no way to clear them (issue #18)** -- if a job was running during an upgrade or restart, its process vanished but the log row stayed "Running" forever: the stop button couldn't find the process and the archive button is hidden for running rows, so the entry could neither be stopped nor removed. Leftover "Running" rows are now automatically marked failed on startup, and for a stuck row whose process no longer exists, Stop force-marks it as failed so it can be cleared

---

## v0.9.32

### 中文

**修复**
- **修复推理模型导致 AI 返回空响应（Issue #17）** -- 签到验证码识别与 AI 选择按钮此前只给了 20/50 的极小 token 上限。DeepSeek、商汤等推理模型会先输出思维链，极小的 token 上限在模型给出答案前就被思维链耗尽，导致 content 返回为空并报"AI API returned an empty response"，而调试界面因默认 token 上限较大（5000）故一切正常。现任务侧统一改用更宽裕的 token 上限，并自动剥离模型内联的 `<think>` 思维链；当 token 上限仍不足以给出答案时，改为提示 token 被截断而非笼统的空响应错误

### English

**Fixes**
- **Fix reasoning models returning an empty AI response (issue #17)** -- captcha recognition and AI button selection used a tiny 20/50 token cap. Reasoning models (DeepSeek, SenseTime, etc.) emit chain-of-thought first, exhausting that tiny budget before producing an answer, so content came back empty with "AI API returned an empty response" -- while the debug interface kept working thanks to its larger default cap (5000). The task path now uses a generous token budget and strips inline `<think>` chain-of-thought; when the budget is still exhausted before an answer, the error names token truncation instead of a generic empty response

---

## v0.9.31

### 中文

**修复**
- **彻底修复内存持续增长问题（Issue #14）** -- v0.9.30 只处理了常驻的长连接客户端，但每次定时任务运行、任务重试、发送 TG 通知、检查账号状态以及各类认证操作都会临时创建一个 Telegram 客户端，用完后仅调用了 disconnect()。GramJS 的 disconnect() 不会停止客户端内部的心跳循环：该循环会把整个客户端对象永久固定在内存中，并且每 9 秒向一个不再被消费的发送队列追加一条 ping 请求，因此即使系统完全空闲，内存也会随任务运行次数累积而平滑增长。现所有临时客户端在用完后改用 destroy() 彻底销毁并释放内存
- **修复登录成功后可能因连接清理超时而报错** -- 提交验证码或 2FA 密码成功后，若清理临时连接时 GramJS 抛出超时错误，此前会导致本已成功的登录被误报为失败；现清理错误不再影响登录结果

### English

**Fixes**
- **Fully fix continued memory growth (issue #14)** -- v0.9.30 only covered the long-lived live clients, but every scheduled job run, retry, TG notification, account status check, and auth operation creates a short-lived Telegram client that was torn down with disconnect() only. GramJS's disconnect() does not stop the client's internal keepalive loop: the loop pins the whole client object in memory forever and appends a ping request every 9 seconds to a send queue nothing drains any more, so memory grew steadily with every job run even while the system was completely idle. All short-lived clients are now torn down with destroy(), fully releasing their memory
- **Fix a successful login occasionally reported as failed** -- after a successful code or 2FA submission, a GramJS timeout thrown while cleaning up the temporary connection could fail the already-successful login; cleanup errors no longer affect the login result

---

## v0.9.30

### 中文

**消息（Messenger）**
- **补全 Telegram 官方功能** -- 拉黑/取消拉黑联系人、举报（垂类原因 + 备注）、删除聊天（可选"为对方也删除"）、删除消息（含批量、"为对方也删除"）、编辑自己发送的消息、转发消息（含批量选择目标聊天）、多选模式（批量转发/删除）、输入中提示（收发双向，聊天列表与聊天头部均显示"对方正在输入…"）
- **举报用户/机器人时同步拉黑并删除聊天** -- 此前举报仅发送举报请求；现举报用户或机器人会同时拉黑对方并删除该聊天，对话框中会提示该行为，操作完成后聊天从列表中移除
- **修复删除聊天后重新出现** -- 删除聊天后刷新对话列表，该聊天此前会因本地缓存未清理而重新出现；现删除后立即从缓存中移除
- **群组/频道搜索大幅改进** -- 此前搜索主要依赖用户名匹配，常搜不到无用户名或非拉丁文标题的群组；现同时匹配本地已加入聊天的标题/用户名，并对已退出、已归档或无用户名的聊天做全局消息内容匹配，兼顾公开聊天的全局用户名匹配，结果按相关性排序；搜索时显示"正在搜索 Telegram…"、失败时给出提示而非静默失败，多词查询搜不到时自动去掉末尾词重试
- **加入群组失败提示更友好** -- 私有群组/频道、邀请链接已失效、已是群成员等场景均有明确文案；私有群加入失败时自动弹出"输入网址"对话框，方便直接粘贴邀请链接
- **移动端聊天头部按钮优化** -- 搜索、清空缓存、小程序模式、打开网址、关闭聊天等按钮在移动端合并为单个 ⋯ 菜单，避免挤占聊天名称显示空间；新增"跳转到最新消息"悬浮按钮，滚动离底部较远时出现，并显示未读消息数角标
- **清除缓存 / 清理账号** -- 消息视图头部新增两个按钮：**清除缓存**（清空该账号本地缓存并重新从 Telegram 拉取，用于排查显示异常）；**清理账号**（退出所有群组与频道、删除所有私聊记录、移除所有联系人及自定义文件夹，自动保留"收藏夹""Telegram 官方通知"和 SpamBot）；清理账号为不可逆操作，需在确认框中勾选"已核对账号名称并了解此操作不可撤销"后才能执行，完成后显示处理结果（成功/失败数量）
- **打开非 Telegram 链接改为可选择** -- 点击站外链接时弹出选择卡片，可选"在 Bemby 中打开"或"在浏览器中打开"；在 Bemby 中打开前会先探测目标网站是否允许被嵌入 iframe，不允许时自动改走内置代理加载，并在页面上方显示"该网站禁止嵌入，已通过 Bemby 代理加载，登录及部分交互功能可能无法使用"提示；代理加载的页面运行在隔离的沙箱环境中，无法访问 Bemby 自身的登录凭据
- **修复机器人编辑消息回复漏检问题** -- 签到与自定义任务中点击按钮后，若机器人是通过编辑已有消息（而非发送新消息）来更新按钮，此前可能被漏检导致任务超时失败；现同时监听消息编辑与新消息两种更新方式，并修复发送指令与开始监听之间的极短时间窗口导致回复丢失的问题，成功/失败关键字匹配也改为综合所有收到的回复消息判断

**AI**
- **修复不同服务商提供同名模型时默认模型可能用错凭据** -- 此前默认模型仅按模型名称匹配，当两个服务商提供同名模型（如同一模型换了服务商）时，系统会任选其中一个有效凭据的服务商，可能并非用户实际选择的那个；现默认模型改为精确锁定到具体的"服务商 + 模型"记录，设置页下拉选项据此区分显示；服务商或模型被删除时会自动清理失效的默认模型指向

**账户**
- **账户列表显示所属国家及国旗** -- 账户列表手机号下方新增一行，显示根据号码国家代码解析出的国旗与国家名称（悬停查看完整名称），名称随界面语言自动切换
- **新增/编辑账户表单校验** -- 名称与手机号现为必填项；未配置全局默认 API 凭据时，API ID 与 API Hash 也为必填项；已知的后端报错信息改为可读的中/英文提示

**列表、筛选与分页**
- **账户、任务、日志、模板列表改为服务端分页与筛选** -- 支持大数据量下的分页浏览，账户与模板新增搜索框（模板搜索支持模糊匹配并按相关度排序），日志新增状态筛选（全部/成功/失败/运行中），任务筛选下拉选项覆盖全部数据而非仅当前页；分页控件移至表格上方，页码/每页数量随刷新自动恢复

### English

**Messenger**
- **Fill out official Telegram feature parity** -- block/unblock a contact, report (with a reason and optional comment), delete a chat (with an optional "also delete for them"), delete messages (single or bulk, with the same revoke option), edit your own sent messages, forward messages (single or bulk, picking a destination chat), multi-select mode for bulk forward/delete, and typing indicators in both directions ("X is typing…" shown in the dialog list and the open chat header)
- **Reporting a user/bot now also blocks and deletes the chat** -- previously report only filed the report; reporting a user or bot now blocks them and deletes the chat in the same action, with the confirmation card calling this out, and the chat disappears from the list once done
- **Fix deleted chats reappearing** -- deleting a chat and then refreshing the dialog list could bring it back because the local cache wasn't pruned; it's now removed from the cache immediately on delete
- **Much better group/channel search** -- search previously relied mostly on username matching and often missed groups without a username or with non-Latin titles; it now matches your own chats by title or username locally, plus a global content search for chats you've left, archived, or that have no username, and a global username search for public chats, all ranked by relevance; shows a "Searching Telegram…" spinner, surfaces errors instead of failing silently, and retries multi-word queries by dropping trailing words when nothing matches
- **Friendlier join-group failures** -- clear messages for private groups/channels, expired invite links, and already-being-a-member; a failed private-group join now auto-opens the "Go to URL" dialog so you can paste the invite link directly
- **Mobile chat header cleanup** -- search, clear cache, mini app mode, open URL, and close chat collapse into a single ⋯ menu on mobile so the chat name keeps its space; a new floating "jump to latest" button appears once you've scrolled away from the bottom, with an unseen-message count badge
- **Clear cache / Clean account** -- two new buttons in the Messenger header: **Clear cache** wipes the account's local cache and refetches everything from Telegram (useful when something looks stale or wrong); **Clean account** leaves every group and channel, deletes every private chat history, and removes all contacts and custom folders (Saved Messages, the official Telegram service chat, and SpamBot are always kept); it's irreversible, so it requires ticking "I checked the account names above and understand this is irreversible" before it can run, and reports how many items succeeded or failed afterwards
- **Opening non-Telegram links now asks first** -- clicking an external link shows a chooser card with "Open in Bemby" or "Open in browser"; choosing Bemby first checks whether the target site allows being embedded, and if it doesn't, loads it through a built-in proxy instead with a banner noting "This site blocks embedding, so it was loaded via the Bemby proxy — sign-ins and some interactive features may not work"; proxied pages run in an isolated sandbox that cannot reach Bemby's own login credentials
- **Fix missed bot replies delivered as message edits** -- when a bot updates its buttons by editing its existing message rather than sending a new one, check-in and custom jobs could previously miss the update and time out; both edit and new-message updates are now watched, a short gap between sending a command and starting to listen no longer drops a fast reply, and success/failure text matching now considers every reply received rather than just one message

**AI**
- **Fix the default model sometimes running against the wrong provider's credentials** -- the default model was previously matched by name only, so when two providers offered a model with the same name, the app could pick either one's credentials rather than the one you actually selected; the default is now pinned to the exact provider + model combination, shown as distinct options in Settings, and automatically cleared if that provider or model is later removed

**Accounts**
- **Show each account's country and flag** -- the phone number column in the Accounts list now shows a flag and country name resolved from the number's calling code (full name on hover), localised to the active UI language
- **Add/edit account form validation** -- name and phone number are now required; API ID and API Hash are required too unless a global default is configured; known backend errors now show a readable message instead of raw text

**Lists, filtering & pagination**
- **Accounts, Jobs, Logs, and Templates move to server-side pagination and filtering** -- these lists now page through large datasets instead of loading everything at once; Accounts and Templates gain a search box (Templates search is fuzzy-matched and relevance-ranked), Logs gains a status filter (all / success / failed / running), and the Jobs filter dropdown now covers the whole dataset rather than just the loaded page; the pagination bar moved to the top of each table, and page/size selections persist across refreshes

---

## v0.9.29-patch-1

### 中文

- **修复 AI 功能在界面中被错误禁用** -- 任务与模板编辑器中的「{aiBtn}（AI 识别）」「{aiInput}」及「输入验证码」选项在密钥已配置的情况下仍显示"未配置密钥"并被禁用；原因是 AI 密钥已迁移至「AI 服务商」，且 v0.9.29 起旧版 `ai_api_key` 设置不再返回给前端，而界面仍依据该旧设置判断密钥是否存在；现设置接口返回服务端计算的 `ai_key_configured` 标志（依次检查 AI 服务商、旧版设置及 `AI_API_KEY` 环境变量），界面据此判断
- **修复升级安装中 AI 密钥回退失效** -- 从旧版本升级时会以旧版设置的内容播种默认 AI 服务商；若密钥当时仅通过 `AI_API_KEY` 环境变量提供，播种出的服务商密钥为空，且运行时不再回退到环境变量，导致 AI 调用报"密钥未配置"；现服务商密钥为空时会正确回退到旧版设置或环境变量

### English

- **Fix AI features wrongly disabled in the UI** -- the "{aiBtn} (AI recognition)", "{aiInput}" and "enter captcha" options in the job and template editors showed "no API key" and stayed disabled even when a key was configured; the AI key moved to AI Suppliers, and since v0.9.29 the legacy `ai_api_key` setting is no longer sent to the client, yet the UI still read that legacy setting to decide whether a key exists; the settings endpoint now returns a server-computed `ai_key_configured` flag (checking AI suppliers, then the legacy setting, then the `AI_API_KEY` env var) which the UI uses instead
- **Fix AI key fallback on upgraded installs** -- upgrading seeds the default AI supplier from the legacy setting; when the key was only ever provided via the `AI_API_KEY` env var, the seeded supplier ended up with an empty key and the runtime no longer fell back to the env var, so AI calls failed with "key not configured"; an empty supplier key now correctly falls back to the legacy setting or the env var

---

## v0.9.29

### 中文

**安全**
- **修复 WebSocket 鉴权绕过（严重）** -- 消息 WebSocket 此前只校验令牌签名，未校验令牌类型，导致公开的验证码令牌（由无需登录的 /api/auth/captcha 签发，使用同一密钥）可用于连接并读取任意账号的实时 Telegram 消息流；现 WebSocket 与 HTTP 接口共用同一套会话令牌校验，并同样强制"必须修改默认密码"
- **拒绝使用默认 JWT 密钥启动（严重）** -- 应用启动时若 JWT_SECRET 为空或仍为公开的占位默认值（如 change-me-in-production）将直接退出；docker-compose 与 env.example 不再提供可用的默认密钥，请用 `openssl rand -hex 32` 生成后设置（升级须知：未设置 JWT_SECRET 的部署需补上该变量方可启动）
- **新增安全响应头与统一错误处理** -- 增加 X-Frame-Options、X-Content-Type-Options、Referrer-Policy、CSP frame-ancestors 及生产环境 HSTS；新增全局错误处理，生产环境不再向客户端泄露堆栈信息（镜像已设置 NODE_ENV=production）
- **容器以非 root 用户运行** -- 通过 su-exec 入口脚本在修正数据目录属主后降权至 node 用户，绑定挂载的现有部署无需手动调整
- **导出加密覆盖更多凭据** -- 当任务/模板配置中含 Emby 用户名或密码时，导出强制加密；账号导出在仅有 API Hash（无会话字符串）时也强制加密
- **其他加固** -- 隐藏遗留的 ai_api_key 设置，不再返回给前端；对自动抢注日志中来自机器人消息的内容进行 HTML 转义；为验证码令牌校验固定 HS256 算法

**调度与任务**
- **任务错峰调度** -- 多个任务随机到同一分钟执行会因高并发导致卡顿甚至失败（#10）；现调度器会自动错开各任务的运行时间，保证彼此至少间隔可配置的分钟数（设置 → 任务错峰，默认 2 分钟，0 表示关闭）；窗口过窄无法满足间隔时自动退化为尽量分散且不重复同一分钟
- **任务并发上限** -- 同一时刻最多并发执行 2 个任务，超出的任务自动排队依次执行，避免偶发的同时触发造成拥塞
- **修复手动运行未回退全局 TG API 凭据** -- 依赖全局默认 API 凭据的账号此前只有定时任务能正常运行，「立即运行」会因缺少凭据而失败；现手动运行与调度器行为一致，无可用凭据时返回明确错误提示（采纳自 #9）
- **API 凭据按整对解析** -- 账号凭据不完整（只填了 API ID 或只填了 Hash）时，此前可能将账号字段与全局默认值混搭导致认证失败；现凭据整对解析：账号凭据完整时用账号的，否则整体使用全局默认（采纳自 #9）
- **日志查询加固与索引** -- 日志列表接口校验 jobId 并将分页上限固定为 200；为 jobs 和 job_logs 新增数据库索引，日志量大时列表页更快；移除未使用的 miniapp 代理路由（采纳自 #9）
- **界面调整** -- 任务类型「自动注册」更名为「抢注」；设置页中「通用设置」与「Emby 观看默认值」卡片位置互换，常用设置更靠前

**构建 / 发布**
- **镜像同步发布至 GHCR** -- 发布流程在推送 Docker Hub 的同时，将同一多架构镜像（amd64/arm64）推送到 GitHub 容器仓库 `ghcr.io/liveinaus/bemby`，版本标签与频道别名（latest/beta/dev）保持一致；使用内置 `GITHUB_TOKEN` 鉴权，无需额外密钥

### English

**Security**
- **Fix WebSocket authentication bypass (critical)** -- the messenger WebSocket previously verified only the token signature, not its type, so the public captcha token (minted by the unauthenticated /api/auth/captcha with the same secret) could be used to connect and read any account's live Telegram message stream; the WebSocket now shares the same session-token validation as the HTTP API and enforces the default-password-change gate
- **Refuse to boot with a default JWT secret (critical)** -- the app now exits at startup if JWT_SECRET is empty or left at a publicly known placeholder (e.g. change-me-in-production); docker-compose and env.example no longer ship a usable default. Generate one with `openssl rand -hex 32` (upgrade note: deployments that never set JWT_SECRET must add it before the app will start)
- **Add security response headers and a non-leaking error handler** -- X-Frame-Options, X-Content-Type-Options, Referrer-Policy, a CSP frame-ancestors directive, and HSTS in production; a global error handler now hides stack traces from clients in production (the image sets NODE_ENV=production)
- **Run the container as a non-root user** -- an su-exec entrypoint fixes data-dir ownership as root then drops to the node user; existing bind-mount deployments need no manual change
- **Export encryption covers more credentials** -- exports are forced to encrypt when a job/template config embeds an Emby username or password, and the account export now forces encryption when an API hash is present even without a session string
- **Other hardening** -- the legacy ai_api_key setting is no longer returned to the client; bot-message-derived content in auto-registration logs is HTML-escaped before rendering; the captcha token verification pins the HS256 algorithm

**Scheduling & jobs**
- **Staggered job scheduling** -- jobs randomly landing on the same minute ran concurrently and often lagged or failed (#10); the scheduler now spaces jobs at least a configurable number of minutes apart (Settings → Job Staggering, default 2 minutes, 0 disables); when a window is too narrow to honour the gap it degrades gracefully, spreading jobs out without doubling up a minute
- **Job concurrency cap** -- at most 2 jobs execute simultaneously; any extras queue and run in turn, so coincidental overlaps no longer thunder the client
- **Fix manual runs not falling back to global TG API credentials** -- accounts relying on the global default credentials previously only worked on the schedule; "Run now" failed for lack of credentials. Manual runs now resolve credentials the same way the scheduler does, with a clear error when none are available (adopted from #9)
- **API credentials resolve as a pair** -- an incomplete account pair (only API ID or only Hash) could previously be mixed with global defaults, producing a mismatched pair that fails authentication; credentials now resolve atomically: the account's own pair when complete, otherwise the global pair (adopted from #9)
- **Log query hardening and indexes** -- the log list endpoint validates jobId and caps page size at 200; new database indexes on jobs and job_logs keep the log pages fast as history grows; removed the unused miniapp proxy route (adopted from #9)
- **UI tweaks** -- the auto-registration job type's Chinese label is renamed from 自动注册 to 抢注; the General Settings and Emby Watch Defaults cards on the Settings page swapped positions so the more commonly used settings appear first

**Build / release**
- **Images also published to GHCR** -- the release workflow now pushes the same multi-arch image (amd64/arm64) to the GitHub Container Registry `ghcr.io/liveinaus/bemby` alongside Docker Hub, with matching version tags and channel aliases (latest/beta/dev); it authenticates with the built-in `GITHUB_TOKEN`, so no extra secret is required

---

## v0.9.28-patch-1

### 中文

- **修复 Emby 观看任务「上报前校验可播放」误判媒体离线** -- 部分服务器以反向代理分流媒体流量，仅支持 PlaybackInfo 返回的 `DirectStreamUrl` 形式（重定向至专用流媒体主机），对通用 `/Videos/{id}/stream` 探测请求直接返回错误，导致校验误判媒体离线、任务失败；现改为与真实播放器行为一致：先调用 PlaybackInfo 并探测其返回的 `DirectStreamUrl`（或 `TranscodingUrl`），失败时再回退到原有静态流地址，磁盘离线检测能力保持不变
- **清理 DeviceId 中的空格** -- 设备名称含空格（如 `Macbook Pro`）时，部分流媒体代理在生成签名重定向地址时会因空格解析失败，导致播放请求出错；现 DeviceId 中的空白字符统一替换为连字符（显示用的设备名称保持原样）

### English

- **Fix Emby watch "verify playable" wrongly reporting media offline** -- servers that front Emby with a stream-offloading reverse proxy only route the `DirectStreamUrl` form returned by PlaybackInfo (redirecting to a dedicated stream host) and reject the generic `/Videos/{id}/stream` probe, so verification wrongly reported media as offline and the job failed; the probe now matches real player behaviour by calling PlaybackInfo and fetching the returned `DirectStreamUrl` (or `TranscodingUrl`) first, falling back to the static stream URL, with disk-offline detection unchanged
- **Sanitise whitespace in DeviceId** -- device names containing spaces (e.g. `Macbook Pro`) broke signed stream redirects on some proxies, failing playback requests; whitespace in the DeviceId is now replaced with hyphens (the display device name is unchanged)

---

## v0.9.28

### 中文

**安全**
- **默认密码强制修改** -- 使用默认密码（`changeme`）登录时，全屏弹窗强制更改密码后方可访问其他页面；JWT 携带 `requirePasswordChange` 标识，未更改前所有 API 请求均返回 403
- **TRUST_PROXY 环境变量** -- 新增 `TRUST_PROXY` 环境变量，用于配置反向代理跳数（如 `1` 表示 nginx/Caddy）；正确设置后 IP 检测与速率限制方可在代理后正常工作
- **WebSocket 鉴权优化** -- 消息客户端 WebSocket 改为首条消息发送鉴权令牌，不再通过 URL 参数传递，避免令牌出现在访问日志中

**账户**
- **TG 账户安全管理** -- 账户编辑面板新增"高级"选项卡，包含：
  - **2FA 密码管理** -- 设置、修改或移除 Telegram 账户的两步验证密码
  - **会话管理** -- 查看所有活跃登录设备（含应用名称、IP、国家、最后活跃时间），可单独终止某个会话或一键终止所有其他设备
  - **恢复邮箱管理** -- 查看（含完整邮箱地址）、设置、更改或移除 Telegram 2FA 恢复邮箱；变更操作均需输入当前 2FA 密码，设置新邮箱时提供完整的邮件确认流程（含重新发送和取消待确认）
  - **通行密钥管理** -- 查看已注册的通行密钥（Passkeys）列表（含名称、添加与最近使用时间）并可移除
- **账户备注** -- 可在账户编辑面板的基本信息选项卡中添加自由文本备注；表格中的备注列可通过"显示/隐藏备注"按钮切换显示（移动端始终隐藏）；支持在勾选多个账户后批量设置备注
- **账户备份加密** -- 导出会话文件时可设置自定义密码加密；导入时自动检测加密状态并提示输入密码；"强制重新认证"选项（推荐）可在导入时清除会话令牌，避免同一令牌被多设备共用导致 Telegram 撤销
- **更新 Telegram 个人资料** -- 在账户编辑面板的"个人资料"选项卡中直接修改该 Telegram 账户的名字、姓氏和简介
- **按名称引用账户** -- 设置中新增开关，开启后消息、任务、模板等引用账户处将以「Bemby 账户名 - TG 账号名」形式显示；账户列表新增 TG 账号列，显示 Telegram 显示名称与用户名（存储于数据库，首次访问自动获取，可手动刷新）
- **设备名称变量** -- TG 应用客户端的设备型号支持 `{name}`、`{tgName}`、`{tgUsername}`、`{id}` 以及随机 `{word:4}`、`{num:4}`、`{alpha:8}`、`{uuid}` 变量，随机值按账户固定，仅在修改模板时重新生成，使每个账户拥有唯一的设备名称

**消息客户端**
- **消息独立视图** -- 消息客户端由弹窗改为独立页面视图，空间更充裕，体验更流畅
- **发送文件与图片** -- 可在聊天中附加并发送图片和任意文件，图片支持"以文件方式发送"选项
- **静音 / 取消静音** -- 右键菜单支持静音 8 小时、1 周、永久静音和取消静音；已静音对话在列表中显示静音徽标
- **加入文件夹** -- 右键菜单可将对话添加至 Telegram 文件夹
- **编辑联系人** -- 在个人资料面板中直接修改联系人姓名（支持名和姓）
- **表情包显示** -- 贴纸消息以图片形式正确显示，不再识别为文件
- **小程序显示模式切换** -- 工具栏新增拼图图标按钮，可在"应用内打开"和"浏览器打开" Telegram 小程序之间切换
- **打开网址对话框** -- 工具栏新增地球图标按钮，支持粘贴任意 URL 或 t.me 链接，直接在消息客户端或浏览器中打开
- **简介链接化** -- 个人资料面板中的简介文本，URL 和 @用户名可点击跳转
- **修复 IME 输入误发** -- 使用中文/日文/韩文输入法时，合成中按下回车不再意外发送消息
- **修复已读状态显示** -- 已读消息正确显示双勾，未读消息显示单勾
- **机器人命令直接发送** -- 从命令菜单选择命令后立即发送，无需再次按回车
- **修复特殊字符发送** -- 含 Markdown 特殊字符（如 `__`）的消息现以纯文本发送，不再被误解析为格式标记

**任务**
- **批量运行任务** -- 在任务列表中勾选多个任务后，点击"运行 (N)"按钮可按顺序依次执行，支持自定义任务间延迟时间（默认 70 秒）
- **批量修改时间窗口** -- 勾选多个任务后可一键将其时间窗口批量修改为相同的开始/结束时间
- **按名称搜索任务** -- 任务列表新增名称搜索框，可快速筛选任务
- **归档任务** -- 任务改为"归档"而非直接删除，保留其历史日志；支持单个及批量归档
- **从日志重跑失败任务** -- 日志视图中可对失败的执行记录一键重新运行
- **新增自定义动作**
  - **加入群组 / 订阅频道** -- 支持公开用户名或私有邀请链接；订阅频道可先校验订阅状态、发送后再次验证；加入群组可选配"入群后点击验证按钮"
  - **向指定联系人发送消息 / 点击按钮** -- 可对流程中指定的机器人、群组或用户发送消息/命令，或点击其最近消息上的按钮
- **上报前校验可播放（Emby）** -- Emby 观看任务上报前先确认媒体文件可读取（磁盘在线），避免文件离线时上报虚假观看

**模板**
- **批量永久静音机器人** -- 在模板列表中勾选多个模板，点击"永久静音机器人"，将为所有关联 Telegram 账户一次性静音该机器人通知（内置速率限制保护，每次间隔 4 秒）

**设置**
- **默认 TG API 凭据** -- 在设置页面统一配置 API ID 和 API Hash，无独立凭据的账户自动使用全局默认值；API Hash 在界面中始终脱敏显示
- **AI 服务商自动切换** -- 新增开关，默认模型返回限速或其他 API 错误时，自动尝试其他已配置的服务商

**可靠性与 Bug 修复**
- **系统升级更稳健** -- 数据库迁移与升级流程增强，修复升级时账户被清空的问题，并新增完整的数据完整性测试
- **日志"加载更多"按钮消失** -- 点击一次后按钮不再消失，可持续加载更早记录
- **移动端输入框缩放** -- 修复 iOS 在点击输入框时自动放大页面的问题
- **底部导航栏** -- 修复底部导航栏在特定场景下不显示的问题
- **账户排序顺序** -- 修复拖拽排序偶发不正确的问题

### English

**Security**
- **Forced admin password change** -- logging in with the default password (`changeme`) now shows a full-screen modal requiring a password change before any other page is accessible; the JWT carries a `requirePasswordChange` claim that blocks all API calls until resolved
- **TRUST_PROXY env var** -- new `TRUST_PROXY` environment variable to configure the number of reverse proxy hops in front of the app (e.g. `1` for nginx/Caddy); required for rate limiting and IP detection to work correctly when behind a proxy
- **WebSocket auth handshake** -- the messenger WebSocket now authenticates via a first-message payload instead of a URL query parameter, keeping the token out of access logs

**Accounts**
- **Telegram account security management** -- account edit panel now has an Advanced tab with:
  - **2FA password management** -- set, change, or remove the two-factor authentication password on any Telegram account
  - **Session management** -- view all active login sessions (app name, IP, country, last active time) with per-session terminate and a one-click "terminate all others" button
  - **Recovery email management** -- view (including full address reveal), set, change, or remove the Telegram 2FA recovery email; all changes require the current 2FA password; a full confirmation code flow (with resend and cancel pending) handles new-address verification
  - **Passkey management** -- list registered WebAuthn passkeys (name, added and last-used times) and remove them
- **Account notes** -- add free-text notes per account from the Basic tab of the edit panel; the Notes column in the accounts table can be shown/hidden via a toggle button (always hidden on mobile); bulk-update notes across selected accounts at once
- **Encrypted account backup** -- account exports can be protected with a user-supplied password; imports auto-detect encryption and prompt for the key; a "Force re-auth" option (recommended) clears session tokens on import to avoid Telegram revoking a shared token
- **Update Telegram profile** -- edit the Telegram account's first name, last name, and bio directly from the Profile tab of the account edit panel
- **Refer to accounts by name** -- a new Settings toggle shows accounts as "{Bemby name} - {TG name}" across the messenger, jobs, and templates; a TG Name column shows each account's Telegram display name and username (stored in the database, auto-fetched on first visit, refreshable on demand)
- **Device name variables** -- the TG app client Device Model now supports `{name}`, `{tgName}`, `{tgUsername}`, `{id}`, and random `{word:4}`, `{num:4}`, `{alpha:8}`, `{uuid}` variables; random values stay fixed per account and only regenerate when the template changes, giving each account a unique device name

**Messenger**
- **Full-page messenger view** -- the messenger moved from a popup to a dedicated page view for more room and a smoother experience
- **Send files and images** -- attach and send images and arbitrary files in a chat; images offer a "send as file" option
- **Mute / unmute** -- context menu offers mute for 8 hours, 1 week, forever, or unmute; muted dialogs show a mute badge in the list
- **Add to folder** -- context menu option to add a chat to any Telegram folder
- **Edit contact** -- edit a contact's first and last name directly in the profile panel
- **Sticker support** -- sticker messages now display correctly as images instead of document attachments
- **Mini app display toggle** -- new puzzle-piece button in the toolbar switches between opening Telegram mini apps in-app (embedded panel) or in the browser
- **Open URL dialog** -- new globe button in the toolbar lets you paste any URL or t.me link and open it in the messenger or browser without leaving the app
- **Bio linkification** -- URLs and @mentions in profile bios are now clickable
- **Fix IME composition send** -- pressing Enter during CJK (Chinese/Japanese/Korean) IME composition no longer accidentally sends the message
- **Fix read status display** -- sent messages correctly show double-tick when read, single-tick when delivered
- **Bot command sends immediately** -- selecting a command from the autocomplete menu now sends it immediately; no need to press Enter again
- **Fix special character sending** -- messages containing Markdown special characters (e.g. `__`) are now sent as plain text and no longer misinterpreted as formatting

**Jobs**
- **Bulk run jobs** -- select multiple jobs and run them sequentially; a configurable delay between runs defaults to 70 seconds
- **Bulk change time window** -- select multiple jobs and set them all to the same start/end window in one action
- **Search jobs by name** -- a name filter box in the jobs list quickly narrows the list
- **Retire jobs** -- jobs are now retired (archived) instead of deleted, preserving their history logs; supports single and bulk retire
- **Rerun failed jobs** -- re-run a failed execution directly from the log view with one click
- **New custom actions**
  - **Join group / Subscribe to channel** -- accepts a public username or private invite link; channel subscribe can pre-check subscription status and re-verify after sending; join group optionally clicks a verification button after joining
  - **Send message / click button for a contact** -- send a message/command to, or click a button on the latest message from, a specific bot, group, or user named in the flow
- **Verify playable before reporting (Emby)** -- Emby Watch jobs confirm the media file is readable (disk online) before reporting, avoiding a fake watch when the file is offline

**Templates**
- **Bulk mute bot forever** -- select templates and mute the associated bot forever across all linked Telegram accounts in one action; built-in 4-second rate-limit protection between account calls

**Settings**
- **Default TG API credentials** -- set a global API ID and Hash in Settings; accounts without their own credentials fall back to these; the Hash is always masked in the UI
- **AI provider auto-fallback** -- new toggle that automatically tries other configured providers when the default model returns a rate-limit or other API error

**Reliability & Bug Fixes**
- **More robust system upgrade** -- hardened database migration and upgrade flow; fixed accounts being wiped on upgrade and added full data-integrity tests
- **Log "Load More" button** -- button no longer disappears after the first click; continues to appear while more records exist
- **Mobile input zoom** -- fixed iOS zooming in when tapping input fields
- **Bottom navigation bar** -- fixed the bottom nav bar not appearing in certain states
- **Account sort order** -- fixed an occasional incorrect sort order after drag-and-drop reordering

---

## v0.9.27-patch-1

### 中文

- **修复 Emby Watch 模板更新清除凭据的问题** -- 更新 Emby Watch 模板时，`syncLinkedJobs` 会将模板配置直接覆盖至关联任务，导致每个任务独立存储的 `username` 和 `password` 被清空；现已修复为按任务合并配置，模板级设置（如 `playDuration`、`markWatched`）正常同步，各任务凭据得以保留

### English

- **Fix Emby Watch template update clearing job credentials** -- updating an Emby Watch template caused `syncLinkedJobs` to overwrite each linked job's config with the raw template config, wiping the per-job `username` and `password`; fixed to merge config per-job so template-level settings (`playDuration`, `markWatched`, etc.) propagate while each job's credentials are preserved

---

## v0.9.27

### 中文

- **消息链接协议白名单** -- Telegram 消息中的 URL 在生成 `<a>` 标签前，现已校验协议白名单（仅允许 `http:`、`https:`、`tg:`）；其他协议（如 `javascript:`、`data:` 等）的链接将以纯文本渲染，不生成可点击链接，消除潜在的 XSS 风险

### English

- **URL protocol whitelist for message links** -- Telegram message URLs are now validated against a protocol whitelist (`http:`, `https:`, `tg:`) before being rendered as `<a>` tags; URLs with any other protocol (e.g. `javascript:`, `data:`) are rendered as plain text instead of clickable links, eliminating a potential XSS vector

---

## v0.9.25

### 中文

- **账号页面新增 TG 账号列** -- 账号列表新增"TG 账号"列，显示每个 Telegram 账号的显示名称和用户名；数据存储于数据库，首次访问时自动获取已认证账号的信息，可通过悬停显示的刷新按钮手动更新；移动端隐藏该列，刷新操作合并至 ⋯ 操作菜单；查看账号状态时同步更新数据库中的显示名称
- **消息客户端导航修复** -- 修复返回按钮和关闭按钮的导航问题；返回按钮现可正确跳转至历史记录中的上一个聊天；关闭 (X) 按钮无导航历史时正确取消选中当前聊天（显示空状态），移动端返回对话列表
- **滚动至顶部自动加载历史消息** -- 消息区域滚动至顶部时自动加载更早的消息，不再需要手动点击"加载更早消息"按钮；同时修复固定消息横幅遮挡该按钮的问题
- **头像加载队列优化** -- 头像改为按需逐个加载，最多 3 个并发请求；按用户 ID 缓存（跨账号共享），已缓存的头像不再重复请求

### English

- **TG Name column on Accounts page** -- a new "TG Name" column shows each account's Telegram display name and username; data is stored in the database, auto-fetched on first visit for authenticated accounts with no stored name, and refreshable on demand via a hover-revealed button; the column is hidden on mobile with a "TG Name" refresh option in the ⋯ action sheet; checking account status also updates the stored display name
- **Messenger back/close navigation fixed** -- the Back button now correctly navigates to the previous chat when history exists; the close (X) button deselects the current chat (shows empty state) when there is no navigation history, or navigates back if there is; on mobile Back still returns to the dialog list
- **Auto-load older messages on scroll** -- scrolling to the top of the messages area now automatically loads older messages, replacing the manual "Load older messages" button; also fixes the pinned message banner blocking that button
- **Avatar loading queue** -- avatars now load on demand one at a time with a maximum of 3 concurrent requests; cached by user ID and shared across all accounts so already-fetched avatars are never re-requested

---

## v0.9.24

### 中文

- **账号会话失效自动检测** -- 账号页面加载时自动检查所有已启用的认证账号；会话失效（AUTH_KEY_DUPLICATED、SESSION_REVOKED 等）时自动标记为"会话已失效"并显示重新认证按钮
- **强制重新认证** -- 编辑面板中新增"强制重新认证"按钮，可一键清除现有会话并重置认证状态，无需删除账号
- **账号拖拽排序** -- 支持在账号列表中通过拖拽手柄对账号进行排序，顺序持久化保存
- **TG 应用客户端随机模式** -- 设置页面新增"账号默认客户端"选项，可在"使用默认"和"随机选择"之间切换；随机模式下，无指定客户端的账号每次连接将从所有预设中随机挑选
- **代理徽章** -- 账号列表中使用代理的账号现显示紫色代理徽章（含代理名称）
- **认证验证码投递修复** -- 使用桌面端客户端预设（Linux、Windows、Mac）时，认证流程不再传递设备参数，避免 Telegram 将验证码路由至不存在的桌面会话；设备配置仅在会话建立后的实时连接中生效
- **内置邀请链接** -- 消息客户端中点击 `t.me/+HASH` 邀请链接时，将在应用内显示群组预览和加入确认对话框，而非跳转至浏览器

### English

- **Automatic session expiry detection** -- all enabled authenticated accounts are checked on the Accounts page load; sessions invalidated by AUTH_KEY_DUPLICATED, SESSION_REVOKED, and related errors are automatically marked as session_expired and a re-auth button is shown
- **Force re-auth** -- a Force Re-auth button in the account edit panel clears the existing session and resets auth status without deleting the account
- **Account drag-and-drop reordering** -- accounts can be reordered by dragging the grip handle; order is persisted
- **TG app client random mode** -- a new "Default client for accounts" toggle in Settings allows switching between a fixed default and random selection; in random mode, accounts with no explicit client pick one at random from all configured presets on each connection
- **Proxy badge** -- accounts using a proxy now show a purple badge with the proxy name inline in the accounts list
- **Auth code delivery fix** -- when a desktop client preset (Linux, Windows, Mac) is configured, device params are no longer passed during the auth code request phase; this prevents Telegram routing the code to a non-existent desktop session; the full device profile is applied only to the live session after authentication
- **In-app invite links** -- clicking a `t.me/+HASH` invite link in the built-in messenger now shows an in-app group preview and join confirmation dialog instead of opening in the browser

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
