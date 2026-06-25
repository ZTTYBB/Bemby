<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ locale === 'zh' ? '帮助' : 'Help' }}</h2>
    </div>

    <div style="display:flex;flex-direction:column;gap:20px;max-width:740px">

      <!-- Overview -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">概览</div>
            <p class="help-para">
              Bemby 自动执行三类任务：Telegram 机器人签到（签到）、Emby 视频观看会话和自定义多步骤流程。
              任务按照可配置的时间窗口每日定时运行。一般流程如下：
            </p>
            <ol class="help-steps">
              <li>在"账户"页面添加并认证一个 <strong>Telegram 账户</strong>。</li>
              <li>创建一个<strong>任务</strong>，关联该账户并配置运行计划。</li>
              <li>调度器每天在时间窗口内随机选择一个时间点自动执行任务。</li>
              <li>查看<strong>日志</strong>以确认结果或排查问题。</li>
            </ol>
            <p class="help-note">筛选条件、列排序方式和上次访问的页面在刷新或重新登录后自动恢复。</p>
          </template>
          <template v-else>
            <div class="card-section-title">Overview</div>
            <p class="help-para">
              Bemby automates three types of tasks: Telegram bot check-ins (签到), Emby video-watch sessions,
              and custom multi-step bot flows. Jobs run on a daily schedule within a configurable time window.
              The general workflow is:
            </p>
            <ol class="help-steps">
              <li>Add and authenticate a <strong>Telegram account</strong> under Accounts.</li>
              <li>Create a <strong>Job</strong>, link it to that account, and configure its schedule.</li>
              <li>The scheduler picks a random time within the window each day and runs the job automatically.</li>
              <li>Check <strong>Logs</strong> to verify results or diagnose failures.</li>
            </ol>
            <p class="help-note">Filter selections, column sort order, and last visited page are automatically restored on refresh or re-login.</p>
          </template>
        </div>
      </div>

      <!-- Accounts -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">账户</div>
            <p class="help-para">账户代表 Telegram 用户会话。每个签到任务需要一个已认证的账户。</p>
            <table class="help-table">
              <tbody><tr><td>API ID / API Hash</td><td>在 <code>my.telegram.org</code> 的"API development tools"中获取。</td></tr>
              <tr><td>发送验证码</td><td>通过 Telegram 向账户手机号发送登录验证码。</td></tr>
              <tr><td>验证</td><td>输入收到的验证码。若启用了二步验证，请在提示时输入 2FA 密码。</td></tr>
            </tbody></table>
            <div class="help-badges-row">
              <span class="badge badge-grey">未认证</span>
              <span class="badge badge-orange">等待验证码 / 二步验证</span>
              <span class="badge badge-green">已认证</span>
            </div>
            <p class="help-note">只有已认证的账户才能运行签到任务。</p>
          </template>
          <template v-else>
            <div class="card-section-title">Accounts</div>
            <p class="help-para">Accounts represent Telegram user sessions. Each check-in job requires one authenticated account.</p>
            <table class="help-table">
              <tbody><tr><td>API ID / API Hash</td><td>Obtain from <code>my.telegram.org</code> under "API development tools".</td></tr>
              <tr><td>Request Code</td><td>Sends a login code to the account's phone number via Telegram.</td></tr>
              <tr><td>Verify</td><td>Enter the code received. If two-factor auth is enabled, enter the 2FA password when prompted.</td></tr>
            </tbody></table>
            <div class="help-badges-row">
              <span class="badge badge-grey">Unauthenticated</span>
              <span class="badge badge-orange">Pending code / 2FA</span>
              <span class="badge badge-green">Authenticated</span>
            </div>
            <p class="help-note">Only authenticated accounts can run check-in jobs.</p>
          </template>
        </div>
      </div>

      <!-- Messenger -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">消息（Messenger）</div>
            <p class="help-para">
              内置 Telegram 消息客户端，可直接在 Bemby 中与联系人、群组和频道实时聊天。
              点击导航栏中的<strong>消息</strong>图标即可打开。
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">表情回应</div>
            <p class="help-para">
              将鼠标悬停在任意消息上，点击笑脸图标即可回应。提供 8 个快捷表情（👍 ❤️ 😂 😮 😢 👎 🔥 🎉）以及完整表情选择器。
              再次点击自己的回应可取消；自己的回应以高亮蓝色显示。
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">引用回复</div>
            <p class="help-para">
              悬停消息后点击回复图标，输入框上方将显示引用预览条。
              点击聊天中的引用气泡可滚动至原始消息并短暂高亮。
              发送后回复关系在 Telegram 中完整保留。
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">内联图片查看</div>
            <p class="help-para">含图片的消息直接在聊天气泡中展示缩略图，无需跳转外部链接。</p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">频道帖子评论</div>
            <p class="help-para">
              频道消息气泡底部若显示评论数，点击该按钮即可在右侧面板中展开评论线程，并可直接发送回复。
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">机器人命令自动补全</div>
            <p class="help-para">
              与机器人聊天时，输入框左侧出现 <code>/</code> 按钮，点击可展开该机器人支持的全部命令及说明。
              在输入框中直接输入 <code>/</code> 也会触发补全面板，继续输入可按前缀筛选命令。
              通过 <kbd>↑</kbd> <kbd>↓</kbd> 方向键或 <kbd>Tab</kbd> / <kbd>Enter</kbd> 选择命令，<kbd>Esc</kbd> 关闭面板。
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">自动标记已读</div>
            <p class="help-para">
              打开聊天窗口或收到新消息时，自动调用 Telegram API 将消息标记为已读，并立即清除对话列表中的未读角标。
            </p>
          </template>
          <template v-else>
            <div class="card-section-title">Messenger</div>
            <p class="help-para">
              A built-in Telegram chat client lets you message contacts, groups, and channels directly from Bemby.
              Click the <strong>Messages</strong> icon in the sidebar to open it.
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Emoji reactions</div>
            <p class="help-para">
              Hover any message and click the smiley icon to react. Eight quick-pick emojis (👍 ❤️ 😂 😮 😢 👎 🔥 🎉) are available alongside a full emoji picker.
              Tap your own reaction again to remove it; your reactions are highlighted blue.
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Quoted replies</div>
            <p class="help-para">
              Hover a message and click the reply icon to quote it. A preview strip appears above the compose box.
              Click any reply quote in the chat to scroll to the original message and briefly highlight it.
              The reply relationship is preserved on Telegram after sending.
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Inline photo viewing</div>
            <p class="help-para">Messages containing photos display the image directly inside the chat bubble -- no external link needed.</p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Channel post comments</div>
            <p class="help-para">
              Channel messages with a comment count show a comment button in the message footer.
              Click it to open the thread panel on the right and reply to the comment thread directly.
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Bot command autocomplete</div>
            <p class="help-para">
              When chatting with a bot, a <code>/</code> button appears beside the compose box. Click it to expand the full list of commands the bot supports, each with its description.
              Typing <code>/</code> directly in the input also opens the panel; keep typing to filter by prefix.
              Navigate with <kbd>↑</kbd> <kbd>↓</kbd> or <kbd>Tab</kbd> / <kbd>Enter</kbd> to select; <kbd>Esc</kbd> closes the panel.
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Auto read-marking</div>
            <p class="help-para">
              Opening a chat or receiving a new message automatically calls the Telegram API to mark messages as read and clears the unread badge on the dialog immediately.
            </p>
          </template>
        </div>
      </div>

      <!-- Jobs -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">任务</div>
            <p class="help-para">支持三种任务类型：</p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">签到（Check-in）</div>
            <p class="help-para">
              向 Telegram 机器人发送命令并点击回复键盘上的按钮，完成每日签到。
              <strong>机器人用户名</strong>字段接受带或不带 <code>@</code> 前缀的机器人账号。
            </p>
            <table class="help-table">
              <tbody><tr><td>启动命令</td><td>发送给机器人的命令，默认 <code>/start</code>。支持模板占位符，留空则使用默认值。</td></tr>
              <tr><td>签到按钮文字</td><td>用于在机器人回复的内联键盘中匹配按钮的文字，默认 <code>签到</code>。设为 <code>{aiBtn}</code> 可启用 AI 自动识别（见下文）。</td></tr>
            </tbody></table>
            <p class="help-para"><strong>AI 按钮识别（<code>{aiBtn}</code>）</strong> — 当机器人以图片提问并展示按钮选项时（如图片验证码签到），将签到按钮文字设为 <code>{aiBtn}</code>，系统将调用视觉大模型自动识别正确按钮。需在<strong>设置</strong>页面的"AI 按钮识别"板块配置 API 地址和密钥，支持 OpenRouter、阿里云百炼等兼容 OpenAI 格式的服务。</p>
            <p class="help-para"><strong>命令模板占位符</strong>——可在启动命令中嵌入动态内容，每次执行时随机生成：</p>
            <table class="help-table">
              <tbody><tr><td><code>{word}</code> / <code>{word:N}</code></td><td>N 位随机小写字母（默认 6 位）</td></tr>
              <tr><td><code>{WORD}</code> / <code>{WORD:N}</code></td><td>N 位随机大写字母（默认 6 位）</td></tr>
              <tr><td><code>{num}</code> / <code>{num:N}</code></td><td>N 位随机数字（默认 6 位）</td></tr>
              <tr><td><code>{alpha}</code> / <code>{alpha:N}</code></td><td>N 位随机大小写字母与数字混合（默认 8 位）</td></tr>
              <tr><td><code>{uuid}</code></td><td>随机 UUID v4</td></tr>
            </tbody></table>
            <p class="help-note">示例：<code>/create {word:4}-{num:6}</code> 发送时会变成 <code>/create abcd-829341</code></p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">观看（Emby Watch）</div>
            <p class="help-para">
              在 Emby 服务器上模拟视频播放会话：随机选择一部影片或剧集，每 30 秒上报进度，
              然后将会话标记为已停止。可用于保持 Emby 账户活跃。
            </p>
            <table class="help-table">
              <tbody><tr><td>服务器地址</td><td>Emby 服务器完整地址，如 <code>https://emby.example.com:443</code>。粘贴含协议和端口的完整 URL 时会自动解析并填充各字段。</td></tr>
              <tr><td>Emby 用户名 / 密码</td><td>用于登录 Emby 账户的凭据。</td></tr>
              <tr><td>播放时长</td><td>模拟播放的秒数。实际时长会在此基础上随机延长 0–10%。留空使用系统默认值。</td></tr>
              <tr><td>用户代理</td><td>从预设列表中选择（SenPlayer、Yamby、Hills、Lenna、VidHub），或选"自定义"手动填写。留空使用设置中配置的默认预设。</td></tr>
              <tr><td>播放后标记已看</td><td>播放结束后调用 Emby API 将该剧集/电影标记为已看。默认开启，可按任务单独配置。</td></tr>
              <tr><td>账号（可选）</td><td>用于发送成功/失败通知的 Telegram 账号。留空则不发送通知。</td></tr>
            </tbody></table>
            <p class="help-note">
              播放从剧集随机 5–10% 处开始，而非从头播放，使行为更接近真实用户。
              Emby 日志中的会话设备将显示为所选 User Agent 预设对应的客户端（默认为 <strong>Mac / SenPlayer</strong>）。
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">自定义（Custom）</div>
            <p class="help-para">
              自定义任务通过可配置的多步骤流程操作任意 Telegram 机器人。每个步骤可执行以下动作：
            </p>
            <table class="help-table">
              <tbody>
                <tr><td>发送命令</td><td>向机器人发送命令或消息。支持模板占位符（<code>{word:N}</code> 等），以及 <code>{aiInput}</code> / <code>{aiInput:N}</code>——自动将上一条消息中的图片发给 AI 识别，将识别出的字符填入发送内容。支持独立的<strong>最大重试次数</strong>配置。</td></tr>
                <tr><td>等待回复</td><td>等待机器人回复（可设置超时时长），支持独立的<strong>最大重试次数</strong>。可选配<strong>成功包含文字</strong>和<strong>失败包含文字</strong>：收到含成功文字的回复则立即标记成功；收到含失败文字的回复则标记失败（并按配置重试）；两者均留空时，任意回复均视为成功。</td></tr>
                <tr><td>点击按钮</td><td>点击内联键盘按钮。支持 <code>{aiBtn}</code>（AI 自动识别）、<code>{anyBtn}</code>（随机选择）或精确文字匹配，并支持独立的<strong>最大重试次数</strong>。</td></tr>
                <tr><td>输入验证码</td><td>等待含图片的机器人消息，通过 AI 识别图中验证码，再将识别结果自动发送给机器人。可指定验证码字符数量以提高识别准确率——若 AI 返回的字符数与预期不符，则视为失败并触发重试。支持独立的<strong>最大重试次数</strong>。</td></tr>
                <tr><td>延时</td><td>在步骤之间插入固定等待时长。</td></tr>
              </tbody>
            </table>
            <p class="help-para">
              <strong>任务最大重试次数</strong>——自定义任务专属设置（独立于全局任务重试），失败时从头重新执行整个动作链。
              <strong>动作最大重试次数</strong>——每个动作仅重试自身，不影响其他步骤。
            </p>
            <p class="help-note">需要在<strong>设置</strong>页面配置 AI API 密钥，方可使用 <code>{aiBtn}</code>、<code>{aiInput}</code> 和"输入验证码"步骤。</p>
            <p class="help-note">AI 的提示词与响应始终显示在步骤日志中，无需开启开发者模式。</p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">时间窗口</div>
            <p class="help-para">
              任务每天在<strong>开始时间</strong>与<strong>结束时间</strong>（均为 HHMM 格式，如 <code>1400</code> 表示 14:00）之间随机一个时间点运行一次。
              若当前时间已在窗口内，则在剩余窗口时间内调度；若窗口已过，则安排在次日执行。
            </p>
            <p class="help-note">
              在设置中关闭<em>每天仅运行一次</em>，可让调度器对今天已运行过的任务重新触发，便于测试。
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">启用 / 禁用</div>
            <p class="help-para">
              点击任务列表中<strong>启用</strong>列的状态标签，可直接切换任务的启用状态，无需打开编辑表单。
              禁用任务时会弹出确认框；重新启用时无需确认。
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">复制任务</div>
            <p class="help-para">
              在任务列表中点击任意任务行的<strong>复制</strong>按钮，可将该任务的全部配置预填至新建任务表单，修改名称后保存即可。
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">任务筛选</div>
            <p class="help-para">
              当系统存在多个账号或多个机器人/网址时，任务列表顶部会显示对应的筛选下拉框，可按账号或机器人/网址过滤任务。
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">列排序</div>
            <p class="help-para">
              点击任意列标题可对任务列表按该列排序，再次点击切换升序/降序。点击行本身可高亮选中该行。
              筛选条件与排序方式在刷新后自动恢复。
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">移动端操作菜单</div>
            <p class="help-para">
              在移动端，每行的操作按钮（运行、编辑、复制、删除）合并为单一的 <strong>⋯</strong> 按钮。
              点击后从屏幕底部弹出操作菜单，选择所需操作后菜单自动关闭；点击空白处可取消。
            </p>
          </template>
          <template v-else>
            <div class="card-section-title">Jobs</div>
            <p class="help-para">Three job types are supported:</p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Check-in (签到)</div>
            <p class="help-para">
              Sends a command to a Telegram bot and clicks the reply keyboard button to perform a daily check-in.
              The <strong>Bot Username</strong> field accepts the bot handle with or without the leading <code>@</code>.
            </p>
            <table class="help-table">
              <tbody><tr><td>Start Command</td><td>Command sent to the bot, default <code>/start</code>. Supports template placeholders. Leave blank to use the default.</td></tr>
              <tr><td>Check-in Button</td><td>Text used to match the inline keyboard button, default <code>签到</code>. Set to <code>{aiBtn}</code> to enable AI auto-detection (see below).</td></tr>
            </tbody></table>
            <p class="help-para"><strong>AI button detection (<code>{aiBtn}</code>)</strong> — when a bot presents an image alongside button choices (e.g. a CAPTCHA-style check-in), set the check-in button to <code>{aiBtn}</code> and a vision model will automatically identify the correct button. Configure the API endpoint and key in the <strong>Settings</strong> page under "AI Button Detection". Any OpenAI-compatible provider works (e.g. OpenRouter, Aliyun DashScope).</p>
            <p class="help-para"><strong>Command template placeholders</strong> — embed dynamic content that is randomly generated each run:</p>
            <table class="help-table">
              <tbody><tr><td><code>{word}</code> / <code>{word:N}</code></td><td>N random lowercase letters (default 6)</td></tr>
              <tr><td><code>{WORD}</code> / <code>{WORD:N}</code></td><td>N random uppercase letters (default 6)</td></tr>
              <tr><td><code>{num}</code> / <code>{num:N}</code></td><td>N random digits (default 6)</td></tr>
              <tr><td><code>{alpha}</code> / <code>{alpha:N}</code></td><td>N random mixed-case alphanumeric characters (default 8)</td></tr>
              <tr><td><code>{uuid}</code></td><td>Random UUID v4</td></tr>
            </tbody></table>
            <p class="help-note">Example: <code>/create {word:4}-{num:6}</code> sends as <code>/create abcd-829341</code></p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Emby Watch (观看)</div>
            <p class="help-para">
              Simulates a video playback session on an Emby server. Picks a random movie or episode, reports
              progress every 30 seconds, then marks the session as stopped. Useful for keeping Emby accounts active.
            </p>
            <table class="help-table">
              <tbody><tr><td>Server URL</td><td>Full address of the Emby server, e.g. <code>https://emby.example.com:443</code>. Paste a URL with protocol and port and the fields are auto-filled.</td></tr>
              <tr><td>Emby Username / Password</td><td>Credentials for the Emby account to log in as.</td></tr>
              <tr><td>Play Duration</td><td>Seconds to simulate playback. Actual duration is this value plus a random 0–10% extra. Blank uses the system default.</td></tr>
              <tr><td>User Agent</td><td>Select from the preset list (SenPlayer, Yamby, Hills, Lenna, VidHub) or choose "Custom..." to enter a value manually. Blank uses the default preset configured in Settings.</td></tr>
              <tr><td>Mark as watched</td><td>Calls the Emby PlayedItems API after playback ends to mark the item as watched. On by default; configurable per job.</td></tr>
              <tr><td>Account (optional)</td><td>Telegram account used to send success/failure notifications. Leave blank to disable notifications for this job.</td></tr>
            </tbody></table>
            <p class="help-note">
              Playback starts at a random position 5–10% into the episode rather than from the beginning, making the session more realistic.
              The device appears in Emby as the client matching the selected User Agent preset (default: <strong>Mac / SenPlayer</strong>).
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Custom (自定义)</div>
            <p class="help-para">
              Custom jobs run configurable multi-step flows against any Telegram bot. Available step types:
            </p>
            <table class="help-table">
              <tbody>
                <tr><td>Send command</td><td>Sends a command or message to the bot. Supports template placeholders (<code>{word:N}</code>, etc.) and <code>{aiInput}</code> / <code>{aiInput:N}</code> -- the image from the previous bot message is sent to AI, the recognised characters are substituted into the message before sending. Has its own <strong>Max retries</strong> setting.</td></tr>
                <tr><td>Wait for reply</td><td>Waits for the bot to reply, with a configurable timeout and its own <strong>Max retries</strong> setting. Optional <strong>Success contains</strong> and <strong>Fail contains</strong> fields let you classify the reply by text: if the reply contains the success text the action succeeds immediately; if it contains the fail text the action fails (and retries if configured). Leave both empty and any reply counts as success.</td></tr>
                <tr><td>Click button</td><td>Clicks an inline keyboard button. Supports <code>{aiBtn}</code> (AI picks the button), <code>{anyBtn}</code> (random pick), or exact text. Has its own <strong>Max retries</strong> setting.</td></tr>
                <tr><td>Enter captcha</td><td>Waits for a bot message containing an image, sends it to AI to recognise the captcha characters, then automatically sends the answer back. An optional character-count hint improves accuracy -- if the AI response does not match the expected length the action fails and retries. Has its own <strong>Max retries</strong> setting.</td></tr>
                <tr><td>Delay</td><td>Pauses for a fixed duration between steps.</td></tr>
              </tbody>
            </table>
            <p class="help-para">
              <strong>Job max retries</strong> -- a per-custom-job setting (separate from the global job retry) that reruns the entire action chain from the beginning on failure.
              <strong>Action max retries</strong> -- each action retries only itself on failure; the rest of the chain is unaffected.
            </p>
            <p class="help-note">An AI API key must be configured in <strong>Settings</strong> before using <code>{aiBtn}</code>, <code>{aiInput}</code>, or Enter captcha steps.</p>
            <p class="help-note">AI prompt and response are always shown in the step log, regardless of whether developer logs are enabled.</p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Schedule Window</div>
            <p class="help-para">
              Jobs run once per day at a random time between <strong>Window Start</strong> and <strong>Window End</strong>
              (both in HHMM format, e.g. <code>1400</code> = 2:00 pm). If the current time is already inside the window,
              the job is scheduled within the remaining window time today. If the window has passed, it is scheduled for
              tomorrow.
            </p>
            <p class="help-note">
              Disable <em>Enforce one run per day</em> in Settings to allow the scheduler to re-trigger jobs that have
              already run today -- useful for testing.
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Enable / Disable</div>
            <p class="help-para">
              Click the status badge in the <strong>Enabled</strong> column to toggle a job on or off without opening the edit form.
              Disabling a job requires confirmation; re-enabling is immediate.
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Duplicate Job</div>
            <p class="help-para">
              Click the <strong>Duplicate</strong> button on any job row to copy all of its settings into the new job form.
              The name is pre-filled as "<em>original name</em> (copy)" -- update it and save.
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Job Filters</div>
            <p class="help-para">
              When more than one account or bot/URL exists, filter dropdowns appear at the top of the jobs list,
              letting you show only jobs for a specific account or bot target.
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Sorting</div>
            <p class="help-para">
              Click any column header to sort the job list by that column; click again to reverse the direction.
              Clicking a row highlights it. Filter selections and sort order are both remembered across page refreshes.
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Mobile Action Menu</div>
            <p class="help-para">
              On mobile, the per-row action buttons (Run, Edit, Duplicate, Delete) are merged into a single <strong>⋯</strong> button.
              Tapping it opens a bottom action sheet; choose an action and the sheet closes automatically, or tap outside to dismiss.
            </p>
          </template>
        </div>
      </div>

      <!-- Templates -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">模板</div>
            <p class="help-para">
              模板存储可复用的任务配置。将任务关联至模板后，模板的变更会自动同步至所有关联任务。
            </p>
            <div class="card-section-title" style="margin-top:16px;font-size:11px">分享模板</div>
            <p class="help-para">
              点击任意行的分享图标，将该模板以 JSON 格式复制至剪贴板。
              如需同时分享多个模板，勾选对应行左侧的复选框，然后点击页头的<strong>分享所选 (N)</strong> 按钮，所有选中模板将以 JSON 数组形式一并复制。
            </p>
            <div class="card-section-title" style="margin-top:16px;font-size:11px">导入模板</div>
            <p class="help-para">
              点击页头的<strong>导入模板</strong>按钮，在弹出的文本框中粘贴 JSON 内容并确认：
            </p>
            <ul class="help-steps">
              <li>粘贴单个 JSON 对象 <code>{"{"}"name": "..."{"}"}</code> — 导入一个模板</li>
              <li>粘贴 JSON 数组 <code>[{"{"}"name": "..."{"}"}, ...]</code> — 批量导入多个模板</li>
            </ul>
          </template>
          <template v-else>
            <div class="card-section-title">Templates</div>
            <p class="help-para">
              Templates store reusable job configurations. Jobs linked to a template inherit its settings;
              changes to the template propagate to all linked jobs automatically.
            </p>
            <div class="card-section-title" style="margin-top:16px;font-size:11px">Sharing templates</div>
            <p class="help-para">
              Click the share icon on any template row to copy it as JSON to the clipboard.
              To share multiple templates at once, tick the checkboxes on the rows you want and click
              <strong>Share Selected (N)</strong> in the page header — all selected templates are copied as a JSON array.
            </p>
            <div class="card-section-title" style="margin-top:16px;font-size:11px">Importing templates</div>
            <p class="help-para">
              Click <strong>Import Template</strong> in the header, paste JSON into the textarea, and confirm:
            </p>
            <ul class="help-steps">
              <li>Paste a single JSON object <code>{"{"}"name": "..."{"}"}</code> to import one template.</li>
              <li>Paste a JSON array <code>[{"{"}"name": "..."{"}"}, ...]</code> to import multiple templates at once.</li>
            </ul>
          </template>
        </div>
      </div>

      <!-- Settings -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">设置</div>
            <table class="help-table">
              <tbody><tr><td>默认时区</td><td>用于计算所有任务的时间窗口。</td></tr>
              <tr><td>默认最大重试次数</td><td>任务失败后的重试次数。</td></tr>
              <tr><td>每天仅运行一次</td><td>防止任务在 24 小时内重复运行。测试时可关闭。</td></tr>
              <tr><td>默认播放时长</td><td>未在任务中单独设置时，Emby 观看会话的默认时长（秒）。</td></tr>
              <tr><td>设备名称</td><td>发送给 Emby API 的设备标识（如 <code>Mac</code>），Emby 会在客户端旁显示该名称。</td></tr>
              <tr><td>默认用户代理</td><td>未在任务中单独选择时使用的 UA 预设。从已有预设中选择，默认为 SenPlayer (Mac)。</td></tr>
              <tr><td>用户代理预设</td><td>管理可在任务中选用的 UA 预设列表。内置 SenPlayer、Yamby、Hills、Lenna、VidHub 五个预设，可按需添加或删除。</td></tr>
              <tr><td>AI 服务商</td><td>管理 AI 服务商和模型。全新安装已预置 OpenRouter（<code>https://openrouter.ai/api/v1</code>）及 <code>nvidia/nemotron-nano-12b-v2-vl:free</code> 模型，在此处填入 API 密钥即可启用 <code>{aiBtn}</code>、<code>{aiInput}</code> 和"输入验证码"功能。支持添加任意 OpenAI 兼容服务商。</td></tr>
              <tr><td>通知目标用户名</td><td>接收通知的 Telegram 用户名，接受 <code>username</code>、<code>@username</code> 或 <code>https://t.me/username</code>。未填写时发至账户"收藏夹"。</td></tr>
              <tr><td>通知触发时机</td><td>选择触发通知的事件：失败（默认）和/或成功，可多选。</td></tr>
              <tr><td>账号导出 / 导入</td><td>将 Telegram 会话数据导出为 JSON 文件，可导入至另一 Bemby 实例，无需重新认证。</td></tr>
            </tbody></table>
            <p class="help-para" style="margin-top:14px">
              <strong>管理员凭据</strong> -- 随时更改管理员用户名或密码，确认更改时需输入当前密码。
            </p>
          </template>
          <template v-else>
            <div class="card-section-title">Settings</div>
            <table class="help-table">
              <tbody><tr><td>Default Timezone</td><td>Used when calculating schedule windows for all jobs.</td></tr>
              <tr><td>Default Max Retries</td><td>How many times a failed job attempt is retried.</td></tr>
              <tr><td>Enforce one run per day</td><td>Prevents a job from running more than once in a 24-hour period. Disable during testing.</td></tr>
              <tr><td>Default Play Duration</td><td>Fallback Emby Watch session length in seconds when not set per-job.</td></tr>
              <tr><td>Device Name</td><td>Device identifier sent to the Emby API (e.g. <code>Mac</code>). Emby displays this alongside the client name.</td></tr>
              <tr><td>Default User Agent</td><td>The UA preset used when a job has no UA selected. Pick from the preset list; defaults to SenPlayer (Mac).</td></tr>
              <tr><td>User Agent Presets</td><td>Manage the preset list available in job forms. Five built-in presets (SenPlayer, Yamby, Hills, Lenna, VidHub) — add or remove custom entries as needed.</td></tr>
              <tr><td>AI Providers</td><td>Manage AI suppliers and models. A fresh install pre-configures OpenRouter (<code>https://openrouter.ai/api/v1</code>) with the <code>nvidia/nemotron-nano-12b-v2-vl:free</code> model — add your API key here to activate <code>{aiBtn}</code>, <code>{aiInput}</code>, and Enter Captcha. Any OpenAI-compatible provider can be added.</td></tr>
              <tr><td>TG Notification Target</td><td>Telegram username to receive notifications. Accepts <code>username</code>, <code>@username</code>, or <code>https://t.me/username</code>. Falls back to Saved Messages if not set.</td></tr>
              <tr><td>Notify On Events</td><td>Which events trigger a notification: failed (default) and/or success. Multi-select.</td></tr>
              <tr><td>Account Export / Import</td><td>Export Telegram session data as a JSON file. Import it into another Bemby instance to transfer accounts without re-authenticating.</td></tr>
            </tbody></table>
            <p class="help-para" style="margin-top:14px">
              <strong>Admin Credentials</strong> -- change the admin username or password at any time.
              Current password is always required to confirm the change.
            </p>
          </template>
        </div>
      </div>

      <!-- Logs -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">日志</div>
            <p class="help-para">
              每次任务执行均记录时间戳、状态和消息。
              使用顶部的任务下拉筛选器按任务缩小范围，或在文本搜索框中输入关键词，对任务名称、账号名称或消息内容进行模糊筛选。
            </p>
            <div class="help-badges-row">
              <span class="badge badge-green">成功</span>
              <span class="badge badge-red">失败</span>
              <span class="badge badge-orange">运行中</span>
            </div>
            <p class="help-para" style="margin-top:10px"><strong>签到任务详情</strong></p>
            <p class="help-para">
              点击任意签到日志行可展开仿 Telegram 气泡样式的对话详情，显示完整的交互过程：
            </p>
            <ol class="help-steps">
              <li>右侧绿色气泡显示发送的命令（含模板展开后的实际内容）。</li>
              <li>左侧灰色气泡显示机器人回复（图片、文字、网页预览）及内联键盘，已点击的按钮以绿色高亮。</li>
              <li>右侧绿色气泡显示实际点击的按钮文字。</li>
              <li>若机器人在按钮点击后有响应（原地编辑或发送新消息），左侧会再显示一个响应气泡。</li>
              <li>若有多次重试，每次尝试均单独展示。</li>
            </ol>
            <p class="help-note">
              使用 <code>{aiBtn}</code> 时，点击气泡下方会显示 <strong>AI · Xms</strong> 标识，表示 AI 选择所用时长。
            </p>
            <p class="help-note">
              对于状态为<strong>运行中</strong>的任务，详情面板每秒自动刷新，可实时查看步骤进展。
              可点击消息列的<strong>停止</strong>按钮随时中止正在运行的任务。
            </p>
            <p class="help-para" style="margin-top:10px"><strong>Emby 观看任务详情</strong></p>
            <p class="help-para">
              点击任意 Emby 观看日志行可展开播放摘要卡片，显示以下信息：
              内容名称（及剧集信息）、剧集总时长、播放起始与结束位置、实际观看时长、是否已标记为已看。
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">归档日志</div>
            <p class="help-para">
              点击非运行中日志行右侧的归档图标，可将该记录软隐藏（不删除数据）。
              归档记录默认不显示；开启列表顶部的<strong>显示已移除</strong>开关可查看所有归档记录。
              点击还原图标可取消归档。
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">开发者日志</div>
            <p class="help-para">
              日志列表顶部有<strong>开发者</strong>开关，开启后可查看以下调试信息：
            </p>
            <ul class="help-steps">
              <li><strong>签到任务</strong>：TG 连接耗时、等待回复耗时（含配置的超时限制）、按钮 API 调用耗时、按钮响应耗时及来源（原地编辑或新消息）、总耗时、错误类型。</li>
              <li><strong>自定义任务</strong>：每步收到的消息数（等待回复步骤）、响应来源、重试次数（点击按钮步骤）及错误类型。</li>
              <li><strong>自定义任务</strong>（进阶元数据）：每步收到的消息数、响应来源、重试次数及错误类型。AI 提示词、响应及耗时无论是否开启此开关均始终显示在步骤日志中。</li>
            </ul>
            <p class="help-note">默认关闭，调试或调优任务参数时开启。</p>
            <p class="help-para" style="margin-top:10px"><strong>AI 调试面板</strong></p>
            <p class="help-para">
              自定义任务日志中，含有 AI 步骤（<code>{aiBtn}</code>、<code>{aiInput}</code> 或"输入验证码"）的步骤标题旁会显示一个烧杯图标。
              点击即可打开调试面板，支持：修改提示词、查看发送给 AI 的图片、调整最大 token 数，然后点击<strong>执行</strong>，
              实时查看 AI 返回的原始响应。可反复调试直到提示词满意，无需重新运行整个任务。
            </p>
          </template>
          <template v-else>
            <div class="card-section-title">Logs</div>
            <p class="help-para">
              Every job execution is recorded with a timestamp, status, and message.
              Use the job dropdown to filter by a specific job, or type in the search box to fuzzy-match across job name, account name, and message.
            </p>
            <div class="help-badges-row">
              <span class="badge badge-green">Success</span>
              <span class="badge badge-red">Failed</span>
              <span class="badge badge-orange">Running</span>
            </div>
            <p class="help-para" style="margin-top:10px"><strong>Check-in detail view</strong></p>
            <p class="help-para">
              Click any check-in log row to expand a Telegram-style chat view showing the full interaction:
            </p>
            <ol class="help-steps">
              <li>A green bubble on the right shows the command that was sent (with any template placeholders already expanded).</li>
              <li>A grey bubble on the left shows the bot's reply -- photo, text, web preview -- with the inline keyboard below it. The clicked button is highlighted green.</li>
              <li>A green bubble on the right shows which button was clicked.</li>
              <li>If the bot responded after the button click -- whether by editing its original message or sending a new one -- the response appears as a second grey bubble on the left.</li>
              <li>If the job retried, each attempt is shown separately.</li>
            </ol>
            <p class="help-note">
              When <code>{aiBtn}</code> is used, an <strong>AI · Xms</strong> badge appears below the clicked button bubble, showing how long the AI took to pick.
            </p>
            <p class="help-note">
              While a job is <strong>Running</strong>, the detail panel refreshes automatically every second so you can watch steps complete in real time.
              Click the <strong>Stop</strong> button in the message column to cancel a running job at any time.
            </p>
            <p class="help-para" style="margin-top:10px"><strong>Emby Watch detail view</strong></p>
            <p class="help-para">
              Click any Emby Watch log row to expand a playback summary card showing: content title (and series/episode info),
              total runtime, start and end positions, actual duration watched, and whether the item was marked as watched.
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Archiving logs</div>
            <p class="help-para">
              Click the archive icon on any non-running log row to soft-hide it without deleting the data.
              Archived records are hidden by default; toggle <strong>Show Retired</strong> at the top of the list to include them.
              Click the restore icon to un-archive.
            </p>

            <div class="card-section-title" style="margin-top:16px;font-size:11px">Developer Logs</div>
            <p class="help-para">
              Toggle <strong>DEV</strong> at the top of the log list to reveal additional diagnostic data:
            </p>
            <ul class="help-steps">
              <li><strong>Check-in jobs</strong>: TG connect time, reply latency (with the configured timeout limit for comparison), button click API time, button response time and source (edited message or new message), total attempt duration, and error type on failure.</li>
              <li><strong>Custom jobs</strong>: per-step metadata including message count received (wait-reply steps), response source and retry count (click-button steps), and error type.</li>
              <li><strong>AI steps</strong>: per-step message count (wait-reply), response source and retry count (click-button), and error type. AI prompt, response, and timing are always visible in the step log regardless of this toggle.</li>
            </ul>
            <p class="help-note">Off by default. Enable when debugging failures or tuning timeout and retry settings.</p>
            <p class="help-para" style="margin-top:10px"><strong>AI Debug Panel</strong></p>
            <p class="help-para">
              Any custom job step that involved AI (<code>{aiBtn}</code>, <code>{aiInput}</code>, or Enter captcha) shows a flask icon next to the step header.
              Click it to open the debug panel: edit the prompt, inspect the image that was sent, adjust max tokens, then click <strong>Run</strong> to call the AI live and see the raw response.
              Iterate on the prompt as many times as needed without re-running the whole job.
            </p>
          </template>
        </div>
      </div>

      <!-- Notifications -->
      <div class="card">
        <div class="card-body">
          <template v-if="locale === 'zh'">
            <div class="card-section-title">通知</div>
            <p class="help-para">
              任务结束时，系统可通过关联的 Telegram 账户向指定目标发送通知。
              在<strong>设置</strong>页面的"TG 通知"板块配置通知目标和触发时机。
            </p>
            <table class="help-table">
              <tbody>
                <tr><td>通知目标</td><td>接收通知的 Telegram 用户名，接受 <code>username</code>、<code>@username</code> 或 <code>https://t.me/username</code> 格式。未填写时回退到关联账户的"收藏夹"。</td></tr>
                <tr><td>通知时机</td><td>选择触发通知的事件：<strong>任务失败</strong>（默认勾选）和/或<strong>任务成功</strong>，可多选。</td></tr>
              </tbody>
            </table>
            <p class="help-note">
              用户主动中止的任务不触发失败通知。
            </p>
          </template>
          <template v-else>
            <div class="card-section-title">Notifications</div>
            <p class="help-para">
              After a job completes, Bemby can send a Telegram notification via the linked account.
              Configure the notification target and trigger events in the <strong>Settings</strong> page under "TG Notifications".
            </p>
            <table class="help-table">
              <tbody>
                <tr><td>Notification Target</td><td>Telegram username to receive notifications. Accepts <code>username</code>, <code>@username</code>, or <code>https://t.me/username</code>. Falls back to the linked account's Saved Messages if not set.</td></tr>
                <tr><td>Notify On Events</td><td>Which events trigger a notification: <strong>Failed</strong> (default) and/or <strong>Success</strong>. Multi-select.</td></tr>
              </tbody>
            </table>
            <p class="help-note">
              Jobs cancelled by the user do not trigger a failure notification.
            </p>
          </template>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import { locale } from '../i18n';
</script>

<style scoped>
.help-para {
  color: #555;
  line-height: 1.7;
  margin-bottom: 10px;
}

.help-steps {
  color: #555;
  line-height: 1.9;
  padding-left: 20px;
  margin-top: 10px;
}

.help-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 12px;
}

.help-table td {
  padding: 7px 10px;
  vertical-align: top;
  font-size: 13px;
  border-bottom: 1px solid #f0f0f0;
  color: #444;
}

.help-table td:first-child {
  font-weight: 600;
  width: 180px;
  color: #222;
  white-space: nowrap;
}

.help-badges-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 10px 0;
}

.help-note {
  font-size: 12px;
  color: #888;
  line-height: 1.6;
  margin-top: 6px;
}

code {
  font-family: 'SFMono-Regular', Consolas, monospace;
  background: #f0f2f5;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
}
</style>
