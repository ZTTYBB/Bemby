<template>
  <div
    :class="inline ? 'tgc-inline-wrap' : 'tgc-backdrop'"
    @click.self="inline ? undefined : $emit('close')"
  >
    <div
      class="tgc-popup"
      :class="{
        'mobile-chat-open': showMobileChat,
        'tgc-popup-inline': inline,
      }"
    >
      <!-- Header -->
      <div class="tgc-header">
        <div class="tgc-header-left">
          <svg
            class="tgc-logo"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            width="20"
            height="20"
          >
            <path
              d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248-2.018 9.51c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.871 4.326-2.962-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.881.71z"
            />
          </svg>
          <span class="tgc-title">Messenger</span>
          <select
            v-model="selectedAccountId"
            class="tgc-account-select"
            @change="onAccountChange"
          >
            <option
              v-for="acc in authenticatedAccounts"
              :key="acc.id"
              :value="acc.id"
            >
              {{ acc.name }}
            </option>
          </select>
        </div>
        <div class="tgc-header-right">
          <button
            class="tgc-icon-btn"
            title="Contacts"
            @click="showContacts = true"
          >
            <i class="fa-solid fa-address-book"></i>
          </button>
          <button
            class="tgc-icon-btn tgc-close-btn"
            @click="$emit('close')"
            title="Close"
          >
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>

      <!-- Body -->
      <div class="tgc-body" :class="{ 'chat-open': showMobileChat }">
        <!-- Sidebar: dialog list -->
        <div class="tgc-sidebar">
          <div class="tgc-search-wrap">
            <i class="fa-solid fa-magnifying-glass tgc-search-icon"></i>
            <input
              v-model="searchQuery"
              class="tgc-search-input"
              placeholder="Search chats..."
              @input="onSearchInput"
            />
            <button
              v-if="searchQuery"
              class="tgc-search-clear"
              @click="
                searchQuery = '';
                searchResults = null;
              "
            >
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>

          <div v-if="tgFolders.length" class="tgc-folder-tabs-wrap">
            <div class="tgc-folder-tabs">
              <button
                class="tgc-folder-tab"
                :class="{ active: activeFolder === 'all' }"
                @click="activeFolder = 'all'"
              >
                All
              </button>
              <button
                v-for="f in tgFolders"
                :key="f.id"
                class="tgc-folder-tab"
                :class="{ active: activeFolder === f.id }"
                @click="activeFolder = f.id"
              >
                {{ f.emoticon ? f.emoticon + " " : "" }}{{ f.title }}
              </button>
            </div>
          </div>

          <div class="tgc-dialog-list">
            <div v-if="loadingDialogs" class="tgc-spinner-wrap">
              <span class="tgc-spinner"></span>
            </div>
            <div v-else-if="dialogError" class="tgc-list-error">
              <i
                class="fa-solid fa-triangle-exclamation tgc-list-error-icon"
              ></i>
              <span>{{ dialogError }}</span>
              <button
                class="tgc-reconnect-btn"
                :disabled="reconnecting"
                @click="reconnectAccount"
              >
                <span v-if="reconnecting"
                  ><span class="tgc-spinner tgc-spinner-sm"></span>
                  Reconnecting...</span
                >
                <span v-else
                  ><i class="fa-solid fa-rotate-right"></i> Reconnect</span
                >
              </button>
            </div>
            <template v-else>
              <div
                v-for="d in displayedDialogs"
                :key="d.chatId"
                class="tgc-dialog-item"
                :class="{ active: activeChatId === d.chatId }"
                @click="openChat(d)"
                @contextmenu="onDialogContextMenu($event, d)"
                @touchstart.passive="onDialogTouchStart($event, d)"
                @touchend.passive="onDialogTouchEnd"
                @touchmove.passive="onDialogTouchEnd"
              >
                <div class="tgc-avatar" :class="`tgc-avatar-${d.type}`" v-avatar-load="d.chatId">
                  <img
                    v-if="avatarSrc(d.chatId)"
                    :src="avatarSrc(d.chatId)"
                    class="tgc-avatar-photo"
                    alt=""
                  />
                  {{ avatarLetter(d.name) }}
                </div>
                <div class="tgc-dialog-info">
                  <div class="tgc-dialog-row">
                    <span class="tgc-dialog-name">{{ d.name }}</span>
                    <span class="tgc-dialog-time">{{
                      d.lastMessage ? fmtTime(d.lastMessage.date) : ""
                    }}</span>
                  </div>
                  <div class="tgc-dialog-row">
                    <span class="tgc-dialog-preview">{{
                      d.lastMessage?.text || ""
                    }}</span>
                    <span v-if="d.unreadCount > 0" class="tgc-unread-badge">{{
                      d.unreadCount
                    }}</span>
                  </div>
                </div>
              </div>
              <div
                v-if="!displayedDialogs.length && !loadingDialogs"
                class="tgc-empty-list"
              >
                No chats found
              </div>
            </template>
          </div>
        </div>

        <!-- Chat + profile panel -->
        <template v-if="activeChat">
          <div class="tgc-chat">
            <!-- Mini App overlay panel -->
            <div v-if="webViewPanel" class="tgc-webview-overlay">
              <div class="tgc-webview-header">
                <span class="tgc-webview-title">{{ webViewPanel.title }}</span>
                <button
                  class="tgc-icon-btn"
                  @click="webViewPanel = null"
                  title="Close"
                >
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
              <iframe
                :src="webViewPanel.url"
                class="tgc-webview-frame"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                allow="camera; microphone; geolocation"
                @load="onWebViewLoad"
              ></iframe>
            </div>

            <div class="tgc-chat-header">
              <button
                v-show="showMobileChat || chatNavStack.length > 0"
                class="tgc-back-btn"
                @click="backToDialogs"
                title="Back to chats"
              >
                <i class="fa-solid fa-arrow-left"></i>
                <span class="tgc-back-label">Back</span>
              </button>
              <div
                class="tgc-avatar tgc-avatar-sm tgc-clickable"
                :class="`tgc-avatar-${activeChat.type}`"
                v-avatar-load="activeChat.chatId"
                @click="openProfile"
              >
                <img
                  v-if="avatarSrc(activeChat.chatId)"
                  :src="avatarSrc(activeChat.chatId)"
                  class="tgc-avatar-photo"
                  alt=""
                />
                {{ avatarLetter(activeChat.name) }}
              </div>
              <div
                class="tgc-chat-title-wrap tgc-clickable"
                @click="openProfile"
              >
                <div class="tgc-chat-name">{{ activeChat.name }}</div>
                <div class="tgc-chat-sub" v-if="activeChat.username">
                  @{{ activeChat.username }}
                </div>
              </div>
              <button
                class="tgc-icon-btn"
                @click="clearChatCache"
                title="Clear cache and reload messages"
              >
                <i class="fa-solid fa-arrows-rotate"></i>
              </button>
              <button
                class="tgc-icon-btn tgc-chat-close-btn"
                @click="closeChat"
                title="Close chat"
              >
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>

            <!-- Pinned message banner -->
            <div
              v-if="pinnedMsg"
              class="tgc-pinned-bar"
              @click="jumpToPinned"
              role="button"
              tabindex="0"
              @keydown.enter="jumpToPinned"
            >
              <i class="fa-solid fa-thumbtack tgc-pinned-icon"></i>
              <div class="tgc-pinned-content">
                <span class="tgc-pinned-label">Pinned Message</span>
                <span class="tgc-pinned-text">{{ pinnedMsg.text }}</span>
              </div>
            </div>

            <div
              class="tgc-messages"
              ref="messagesEl"
              @scroll="onMsgScroll"
              @click="activeMsgId = null"
            >
              <div v-if="loadingOlder" class="tgc-load-more">
                <span class="tgc-spinner"></span>
              </div>
              <div
                v-if="loadingMessages"
                class="tgc-spinner-wrap"
                style="height: 100%"
              >
                <span class="tgc-spinner"></span>
              </div>
              <template v-else>
                <div
                  v-for="(msg, idx) in messages"
                  :key="msg.id"
                  :data-msg-id="msg.id"
                >
                  <!-- Date separator -->
                  <div
                    v-if="
                      idx === 0 || !sameDay(messages[idx - 1].date, msg.date)
                    "
                    class="tgc-date-sep"
                  >
                    {{ fmtDate(msg.date) }}
                  </div>

                  <!-- Unread messages marker -->
                  <div
                    v-if="firstUnreadId !== null && msg.id === firstUnreadId"
                    class="tgc-unread-sep"
                  >
                    Unread messages
                  </div>

                  <div
                    class="tgc-msg-wrap"
                    :class="[
                      msg.fromMe ? 'tgc-msg-out' : 'tgc-msg-in',
                      { 'tgc-msg-active': activeMsgId === msg.id },
                    ]"
                  >
                    <!-- Sender avatar (groups with known senders only) -->
                    <template
                      v-if="
                        !msg.fromMe && msg.fromId && activeChat.type === 'group'
                      "
                    >
                      <div
                        v-if="showSenderAvatar(idx)"
                        class="tgc-sender-av"
                        :style="!avatarSrc(msg.fromId) ? { background: senderColor(msg.fromId) } : {}"
                        :title="msg.fromName || ''"
                        v-avatar-load="msg.fromId"
                      >
                        <img
                          v-if="avatarSrc(msg.fromId)"
                          :src="avatarSrc(msg.fromId)"
                          class="tgc-sender-av-photo"
                          alt=""
                        />
                        <template v-else>{{ avatarLetter(msg.fromName || "?") }}</template>
                      </div>
                      <div v-else class="tgc-sender-av-ph"></div>
                    </template>

                    <!-- Hover action bar -->
                    <div class="tgc-msg-actions">
                      <button
                        class="tgc-msg-action"
                        title="Reply"
                        @click.stop="startReply(msg)"
                      >
                        <i class="fa-solid fa-reply"></i>
                      </button>
                      <button
                        class="tgc-msg-action"
                        title="React"
                        @click.stop="openReactPicker(msg, $event)"
                      >
                        <i class="fa-regular fa-face-smile"></i>
                      </button>
                      <button
                        v-if="msg.replyCount"
                        class="tgc-msg-action"
                        title="View thread"
                        @click.stop="openThread(msg)"
                      >
                        <i class="fa-regular fa-comment"></i>
                      </button>
                    </div>

                    <div
                      class="tgc-msg-bubble"
                      @click.stop="
                        activeMsgId = activeMsgId === msg.id ? null : msg.id
                      "
                    >
                      <div
                        v-if="
                          !msg.fromMe &&
                          activeChat.type !== 'user' &&
                          activeChat.type !== 'bot' &&
                          msg.fromName
                        "
                        class="tgc-msg-sender"
                      >
                        {{ msg.fromName }}
                      </div>
                      <!-- Reply quote -->
                      <div
                        v-if="msg.replyToId"
                        class="tgc-reply-quote"
                        @click.stop="scrollToReply(msg.replyToId)"
                      >
                        <div class="tgc-reply-bar"></div>
                        <div class="tgc-reply-content">
                          <div class="tgc-reply-name">
                            {{ msg.replyToName || "Message" }}
                          </div>
                          <div class="tgc-reply-text">
                            {{ msg.replyToText || "..." }}
                          </div>
                        </div>
                      </div>
                      <img
                        v-if="msg.hasPhoto"
                        :src="photoUrl(msg.id)"
                        class="tgc-msg-photo"
                        loading="lazy"
                        @error="
                          (e: Event) =>
                            ((e.target as HTMLImageElement).style.display =
                              'none')
                        "
                      />
                      <div
                        v-if="msg.text || msg.html"
                        class="tgc-msg-text"
                        v-html="msg.html ?? escMsgText(msg.text)"
                        @click="onMsgLinkClick($event)"
                      ></div>
                      <div
                        v-if="!msg.text && msg.hasDocument"
                        class="tgc-msg-text tgc-msg-doc"
                      >
                        <i class="fa-solid fa-file"></i> Document
                      </div>
                      <!-- Reactions -->
                      <div v-if="msg.reactions?.length" class="tgc-reactions">
                        <button
                          v-for="r in msg.reactions"
                          :key="r.emoji"
                          class="tgc-reaction"
                          :class="{ 'tgc-reaction-mine': r.mine }"
                          @click.stop="doReact(msg.id, r.emoji)"
                        >
                          {{ r.emoji }}
                          <span class="tgc-reaction-count">{{ r.count }}</span>
                        </button>
                      </div>
                      <div class="tgc-msg-meta">
                        <!-- Comment count -->
                        <button
                          v-if="msg.replyCount"
                          class="tgc-comment-btn"
                          @click.stop="openThread(msg)"
                        >
                          <i class="fa-regular fa-comment"></i>
                          {{ msg.replyCount }}
                        </button>
                        <span class="tgc-msg-time">{{
                          fmtMsgTime(msg.date)
                        }}</span>
                        <i
                          v-if="msg.fromMe"
                          class="fa-solid fa-check tgc-msg-tick"
                        ></i>
                      </div>
                      <!-- Inline keyboard buttons -->
                      <div v-if="msg.buttons" class="tgc-msg-buttons">
                        <div
                          v-for="(row, ri) in msg.buttons"
                          :key="ri"
                          class="tgc-btn-row"
                        >
                          <button
                            v-for="(btn, bi) in row"
                            :key="bi"
                            class="tgc-btn-chip"
                            :class="{
                              'tgc-btn-loading':
                                btnLoadingKey === `${msg.id}-${ri}-${bi}`,
                            }"
                            :disabled="
                              (!btn.data && !btn.url) ||
                              btnLoadingKey === `${msg.id}-${ri}-${bi}`
                            "
                            @click="clickInlineButton(msg, btn, ri, bi)"
                          >
                            {{ btn.text }}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div v-if="!messages.length" class="tgc-empty-chat">
                  No messages yet
                </div>
              </template>
            </div>

            <!-- Command suggestions -->
            <div v-if="commandSuggestions.length" class="tgc-cmd-suggestions">
              <div
                v-for="(cmd, i) in commandSuggestions"
                :key="cmd.command"
                class="tgc-cmd-item"
                :class="{ 'tgc-cmd-selected': i === selectedCmdIdx }"
                @click="selectCommand(cmd)"
              >
                <span class="tgc-cmd-name">/{{ cmd.command }}</span>
                <span class="tgc-cmd-desc">{{ cmd.description }}</span>
              </div>
            </div>

            <!-- Join bar shown when the user is not a member -->
            <div v-if="activeChat?.left" class="tgc-join-bar">
              <template v-if="joinRequestSent">
                <div class="tgc-join-pending">
                  <i class="fa-solid fa-clock"></i>
                  <span
                    >Complete the verification task -- check the chat above or a private message from the group bot.</span
                  >
                </div>
                <button
                  class="tgc-join-check-btn"
                  @click="checkMembershipStatus(); refreshMessages()"
                >
                  <i class="fa-solid fa-rotate"></i> Check now
                </button>
              </template>
              <button
                v-else
                class="tgc-join-btn"
                :disabled="joiningChannel"
                @click="joinCurrentChat"
              >
                <span v-if="joiningChannel">
                  <span class="tgc-spinner tgc-spinner-sm"></span> Joining...
                </span>
                <span v-else>
                  <i class="fa-solid fa-right-to-bracket"></i>
                  {{ activeChat?.type === "channel" ? "Subscribe" : "Join Group" }}
                </span>
              </button>
            </div>

            <div v-else class="tgc-compose">
              <!-- Reply strip -->
              <div v-if="replyingTo" class="tgc-reply-strip">
                <i class="fa-solid fa-reply tgc-reply-strip-icon"></i>
                <div class="tgc-reply-strip-body">
                  <div class="tgc-reply-strip-name">
                    {{ replyingTo.fromName || "Message" }}
                  </div>
                  <div class="tgc-reply-strip-text">
                    {{ replyingTo.text || "..." }}
                  </div>
                </div>
                <button
                  class="tgc-icon-btn"
                  @click="replyingTo = null"
                  title="Cancel reply"
                >
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
              <div class="tgc-compose-row">
                <!-- Commands button for bots -->
                <button
                  v-if="botCommands.length"
                  class="tgc-slash-btn"
                  :class="{ active: commandSuggestions.length }"
                  title="Bot commands"
                  @click="openCommandMenu"
                >
                  /
                </button>
                <textarea
                  v-model="inputText"
                  class="tgc-input"
                  placeholder="Write a message..."
                  rows="1"
                  @keydown="onComposeKey"
                  @input="autoResize"
                  ref="inputEl"
                ></textarea>
                <button
                  class="tgc-send-btn"
                  :disabled="!inputText.trim() || sending"
                  @click="sendMessage"
                  title="Send (Enter)"
                >
                  <i class="fa-solid fa-paper-plane"></i>
                </button>
              </div>
            </div>
          </div>

          <!-- Profile info panel / Thread panel (flex sibling of chat) -->
          <div v-if="showProfile && !showThread" class="tgc-profile-panel">
            <div class="tgc-profile-header">
              <span class="tgc-profile-title">Info</span>
              <button class="tgc-icon-btn" @click="showProfile = false">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>

            <div v-if="profileLoading" class="tgc-spinner-wrap" style="flex: 1">
              <span class="tgc-spinner"></span>
            </div>
            <div v-else-if="profileDetails" class="tgc-profile-body">
              <div class="tgc-profile-avatar-wrap">
                <div
                  class="tgc-profile-avatar"
                  :class="`tgc-avatar-${profileDetails.type}`"
                  v-avatar-load="profileDetails.chatId"
                >
                  <img
                    v-if="avatarSrc(profileDetails.chatId)"
                    :src="avatarSrc(profileDetails.chatId)"
                    class="tgc-avatar-photo"
                    alt=""
                  />
                  {{ avatarLetter(profileDetails.name) }}
                </div>
                <div class="tgc-profile-name">{{ profileDetails.name }}</div>
                <div class="tgc-profile-type-badge">
                  {{ profileDetails.type }}
                </div>
              </div>

              <div class="tgc-profile-rows">
                <div
                  v-if="profileDetails.username"
                  class="tgc-profile-row"
                  @click="copyField('@' + profileDetails.username)"
                >
                  <i class="fa-solid fa-at tgc-profile-row-icon"></i>
                  <div class="tgc-profile-row-body">
                    <div class="tgc-profile-row-label">Username</div>
                    <div class="tgc-profile-row-value">
                      @{{ profileDetails.username }}
                    </div>
                  </div>
                  <i class="fa-regular fa-copy tgc-copy-icon"></i>
                </div>

                <div
                  v-if="profileDetails.phone"
                  class="tgc-profile-row"
                  @click="copyField(profileDetails.phone!)"
                >
                  <i class="fa-solid fa-phone tgc-profile-row-icon"></i>
                  <div class="tgc-profile-row-body">
                    <div class="tgc-profile-row-label">Phone</div>
                    <div class="tgc-profile-row-value">
                      {{ profileDetails.phone }}
                    </div>
                  </div>
                  <i class="fa-regular fa-copy tgc-copy-icon"></i>
                </div>

                <div
                  v-if="profileDetails.bio"
                  class="tgc-profile-row tgc-profile-row-nocopy"
                >
                  <i class="fa-solid fa-circle-info tgc-profile-row-icon"></i>
                  <div class="tgc-profile-row-body">
                    <div class="tgc-profile-row-label">Bio</div>
                    <div class="tgc-profile-row-value tgc-bio-text">
                      {{ profileDetails.bio }}
                    </div>
                  </div>
                </div>

                <div
                  v-if="profileDetails.memberCount"
                  class="tgc-profile-row tgc-profile-row-nocopy"
                >
                  <i class="fa-solid fa-users tgc-profile-row-icon"></i>
                  <div class="tgc-profile-row-body">
                    <div class="tgc-profile-row-label">Members</div>
                    <div class="tgc-profile-row-value">
                      {{ profileDetails.memberCount.toLocaleString() }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <!-- Thread panel -->
          <div v-if="showThread" class="tgc-thread-panel">
            <div class="tgc-profile-header">
              <span class="tgc-profile-title">
                Thread
                <span
                  v-if="threadRootMsg?.replyCount"
                  class="tgc-thread-count"
                  >{{ threadRootMsg.replyCount }}</span
                >
              </span>
              <button class="tgc-icon-btn" @click="showThread = false">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
            <!-- Root message preview -->
            <div v-if="threadRootMsg" class="tgc-thread-root">
              <div class="tgc-thread-root-text">
                {{ threadRootMsg.text || "(media)" }}
              </div>
            </div>
            <!-- Thread messages -->
            <div class="tgc-thread-messages" ref="threadEl">
              <div v-if="loadingThread" class="tgc-spinner-wrap">
                <span class="tgc-spinner"></span>
              </div>
              <template v-else>
                <div
                  v-for="msg in threadMessages"
                  :key="msg.id"
                  class="tgc-thread-msg"
                  :class="
                    msg.fromMe ? 'tgc-thread-msg-out' : 'tgc-thread-msg-in'
                  "
                >
                  <div class="tgc-thread-msg-name" v-if="!msg.fromMe">
                    {{ msg.fromName || "User" }}
                  </div>
                  <div
                    class="tgc-thread-msg-text"
                    v-html="msg.html ?? escMsgText(msg.text)"
                    @click="onMsgLinkClick($event)"
                  ></div>
                  <div class="tgc-thread-msg-time">
                    {{ fmtMsgTime(msg.date) }}
                  </div>
                </div>
                <div v-if="!threadMessages.length" class="tgc-empty-list">
                  No comments yet
                </div>
              </template>
            </div>
            <!-- Thread compose -->
            <div class="tgc-thread-compose">
              <textarea
                v-model="threadInputText"
                class="tgc-input"
                placeholder="Write a comment..."
                rows="1"
                @keydown.enter.exact.prevent="sendThreadMessage"
              ></textarea>
              <button
                class="tgc-send-btn"
                :disabled="!threadInputText.trim() || sendingThread"
                @click="sendThreadMessage"
              >
                <i class="fa-solid fa-paper-plane"></i>
              </button>
            </div>
          </div>
        </template>

        <!-- Empty state -->
        <div class="tgc-empty-state" v-else>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            width="56"
            height="56"
            style="opacity: 0.25"
          >
            <path
              d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248-2.018 9.51c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.871 4.326-2.962-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.881.71z"
            />
          </svg>
          <p>Select a conversation to start chatting</p>
        </div>
      </div>
      <!-- end tgc-body -->
    </div>
    <!-- end tgc-popup -->

    <!-- Context menu dismiss backdrop -->
    <div
      v-if="ctxMenu"
      class="tgc-ctx-backdrop"
      @click="closeCtx"
      @contextmenu.prevent="closeCtx"
    ></div>

    <!-- Dialog context menu (right-click / long-press) -->
    <div
      v-if="ctxMenu"
      class="tgc-ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
    >
      <button class="tgc-ctx-item" @click="ctxMute(0)">
        <i class="fa-solid fa-bell"></i> Unmute
      </button>
      <button class="tgc-ctx-item" @click="ctxMute(8 * 3600)">
        <i class="fa-solid fa-bell-slash"></i> Mute 8 hours
      </button>
      <button class="tgc-ctx-item" @click="ctxMute(7 * 24 * 3600)">
        <i class="fa-solid fa-bell-slash"></i> Mute 1 week
      </button>
      <button class="tgc-ctx-item" @click="ctxMute(365 * 24 * 3600)">
        <i class="fa-solid fa-bell-slash"></i> Mute forever
      </button>
      <div class="tgc-ctx-divider"></div>
      <button class="tgc-ctx-item" @click="ctxPin(true)">
        <i class="fa-solid fa-thumbtack"></i> Pin
      </button>
      <button class="tgc-ctx-item" @click="ctxPin(false)">
        <i class="fa-regular fa-thumbtack"></i> Unpin
      </button>
    </div>

    <!-- Emoji reaction picker -->
    <div
      v-if="emojiPickerMsgId !== null"
      class="tgc-ctx-backdrop"
      @click="emojiPickerMsgId = null"
    ></div>
    <div
      v-if="emojiPickerMsgId !== null"
      class="tgc-emoji-picker"
      :style="{
        left: emojiPickerPos.x + 'px',
        top: emojiPickerPos.y + 'px',
        transform: 'translateY(-110%)',
      }"
    >
      <button
        v-for="e in QUICK_EMOJIS"
        :key="e"
        class="tgc-emoji-btn"
        @click="pickReaction(e)"
      >
        {{ e }}
      </button>
    </div>

    <!-- Copy toast -->
    <div v-if="copyToast" class="tgc-copy-toast">{{ copyToast }}</div>

    <!-- Contacts sub-panel -->
    <div
      v-if="showContacts"
      class="tgc-contacts-overlay"
      @click.self="showContacts = false"
    >
      <div class="tgc-contacts-panel">
        <div class="tgc-contacts-header">
          <span>Contacts</span>
          <button class="tgc-icon-btn" @click="showContacts = false">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="tgc-contacts-search">
          <i class="fa-solid fa-magnifying-glass tgc-search-icon"></i>
          <input
            v-model="contactSearch"
            class="tgc-search-input"
            placeholder="Search contacts..."
          />
        </div>

        <div class="tgc-contact-list">
          <div v-if="loadingContacts" class="tgc-spinner-wrap">
            <span class="tgc-spinner"></span>
          </div>
          <template v-else>
            <div
              v-for="c in filteredContacts"
              :key="c.chatId"
              class="tgc-contact-item"
              @click="openContactChat(c)"
            >
              <div class="tgc-avatar tgc-avatar-user tgc-avatar-sm">
                {{ avatarLetter(c.firstName || c.username || "?") }}
              </div>
              <div class="tgc-contact-info">
                <div class="tgc-contact-name">
                  {{ c.firstName }} {{ c.lastName }}
                </div>
                <div class="tgc-contact-sub">
                  {{ c.username ? "@" + c.username : (c.phone ?? "") }}
                </div>
              </div>
            </div>
            <div v-if="!filteredContacts.length" class="tgc-empty-list">
              No contacts
            </div>
          </template>
        </div>

        <!-- Add contact form -->
        <div class="tgc-add-contact">
          <div class="tgc-add-contact-title">Add Contact</div>
          <div class="tgc-add-contact-fields">
            <input
              v-model="newPhone"
              class="form-input"
              placeholder="+1234567890"
            />
            <input
              v-model="newFirstName"
              class="form-input"
              placeholder="First name"
            />
            <button
              class="btn btn-primary"
              :disabled="
                !newPhone.trim() || !newFirstName.trim() || addingContact
              "
              @click="addContactSubmit"
            >
              {{ addingContact ? "..." : "Add" }}
            </button>
          </div>
          <div v-if="addContactError" class="error-msg" style="margin-top: 6px">
            {{ addContactError }}
          </div>
          <div v-if="addContactOk" class="success-msg" style="margin-top: 6px">
            Contact added!
          </div>
        </div>
      </div>
    </div>
  </div>
  <!-- Invite link join confirmation -->
  <div
    v-if="invitePreview || checkingInvite"
    class="tgc-invite-overlay"
    @click.self="invitePreview = null"
  >
    <div class="tgc-invite-card">
      <template v-if="checkingInvite">
        <span
          class="tgc-spinner"
          style="margin: 24px auto; display: block; width: 28px; height: 28px"
        ></span>
      </template>
      <template v-else-if="invitePreview">
        <div class="tgc-invite-icon">
          <i
            :class="
              invitePreview.type === 'channel'
                ? 'fa-solid fa-bullhorn'
                : 'fa-solid fa-users'
            "
          ></i>
        </div>
        <div class="tgc-invite-title">{{ invitePreview.title }}</div>
        <div class="tgc-invite-meta">
          {{ invitePreview.memberCount.toLocaleString() }}
          {{ invitePreview.type === "channel" ? "subscribers" : "members" }}
        </div>
        <div class="tgc-invite-actions">
          <button class="tgc-invite-cancel" @click="invitePreview = null">
            Cancel
          </button>
          <button
            class="tgc-invite-join"
            :disabled="joiningInvite"
            @click="confirmJoinInvite"
          >
            <span v-if="joiningInvite"
              ><span class="tgc-spinner tgc-spinner-sm"></span> Joining...</span
            >
            <span v-else
              >Join
              {{ invitePreview.type === "channel" ? "Channel" : "Group" }}</span
            >
          </button>
        </div>
      </template>
    </div>
  </div>
  <!-- end tgc-backdrop -->
</template>

<script setup lang="ts">
import {
  ref,
  reactive,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
} from "vue";
import {
  accountsApi,
  tgClientApi,
  type Account,
  type TgDialog,
  type TgMessage,
  type TgReaction,
  type TgBotCommand,
  type TgContact,
  type TgFolder,
  type TgProfile,
  type TgInvitePreview,
} from "../api/client";
import { avatarCache, avatarQueue, avatarQueued, avatarFetching, avatarConcurrencyState, persistAvatarCache } from "../composables/avatarCache";

const { inline = false } = defineProps<{ inline?: boolean }>();
const emit = defineEmits<{ close: [] }>();

// ── Messenger state persistence ───────────────────────────────────────────────

const MESSENGER_STATE_KEY = "bemby_messenger_state";
type MessengerState = { accountId: number; dialog: TgDialog | null };

function loadMessengerState(): MessengerState | null {
  try {
    const raw = localStorage.getItem(MESSENGER_STATE_KEY);
    return raw ? (JSON.parse(raw) as MessengerState) : null;
  } catch {
    return null;
  }
}

function saveMessengerState(): void {
  if (!selectedAccountId.value) {
    localStorage.removeItem(MESSENGER_STATE_KEY);
    return;
  }
  try {
    const state: MessengerState = {
      accountId: selectedAccountId.value,
      dialog: activeChat.value ?? null,
    };
    localStorage.setItem(MESSENGER_STATE_KEY, JSON.stringify(state));
  } catch {}
}

// ── State ─────────────────────────────────────────────────────────────────────

const accounts = ref<Account[]>([]);
const authenticatedAccounts = computed(() =>
  accounts.value.filter((a) => a.authStatus === "authenticated" && !a.disabled),
);

const selectedAccountId = ref<number | null>(null);
const dialogs = ref<TgDialog[]>([]);
const loadingDialogs = ref(false);
const dialogError = ref("");
const reconnecting = ref(false);

const AVATAR_CONCURRENCY = 3;

const searchQuery = ref("");
const searchResults = ref<TgDialog[] | null>(null);
const searchTimer = ref<ReturnType<typeof setTimeout> | null>(null);

const activeChatId = ref<string | null>(null);
const activeChat = ref<TgDialog | null>(null);
const messages = ref<TgMessage[]>([]);
const pinnedMsg = ref<TgMessage | null>(null);
const firstUnreadId = ref<number | null>(null);
const loadingMessages = ref(false);
const loadingOlder = ref(false);
const canLoadMore = ref(true);
const sending = ref(false);
const inputText = ref("");

const joiningChannel = ref(false);
const joinRequestSent = ref(false);
// chatId of the group/channel whose join request is pending -- survives chat navigation
const pendingJoinChatId = ref<string | null>(null);
let membershipPollTimer: ReturnType<typeof setInterval> | null = null;

// Debounced mark-read -- coalesces rapid calls (e.g. burst of incoming messages) into one request
let markReadTimer: ReturnType<typeof setTimeout> | null = null;
let markReadPending: { chatId: string; maxId: number } | null = null;

// Watcher that keeps re-fetching the last bot message while the bot is still editing it
let botMsgWatchTimer: ReturnType<typeof setTimeout> | null = null;
let botMsgWatchGen = 0;
let botMsgWatchText = '';
let botMsgWatchStaleTicks = 0;
let botMsgWatchTotalTicks = 0;

const showContacts = ref(false);
const contacts = ref<TgContact[]>([]);
const loadingContacts = ref(false);
const contactSearch = ref("");
const newPhone = ref("");
const newFirstName = ref("");
const addingContact = ref(false);
const addContactError = ref("");
const addContactOk = ref(false);

const messagesEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
const showMobileChat = ref(false);
const showProfile = ref(false);
const webViewPanel = ref<{ url: string; title: string } | null>(null);
const profileDetails = ref<TgProfile | null>(null);
const profileLoading = ref(false);
const copyToast = ref("");
const btnLoadingKey = ref<string | null>(null);

// Reply compose
const replyingTo = ref<TgMessage | null>(null);

// Emoji reaction picker
const emojiPickerMsgId = ref<number | null>(null);
const activeMsgId = ref<number | null>(null);
const emojiPickerPos = ref({ x: 0, y: 0 });
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "👎", "🔥", "🎉"];

// Bot commands
const botCommands = ref<TgBotCommand[]>([]);
const selectedCmdIdx = ref(-1);

// Invite link preview / join confirmation
const invitePreview = ref<TgInvitePreview | null>(null);
const checkingInvite = ref(false);
const joiningInvite = ref(false);

// Chat navigation history -- used so "back" returns to the previous chat
// when the user was navigated here from within another chat (e.g. via invite link or URL button)
const chatNavStack = ref<TgDialog[]>([]);

// Thread / comments panel
const showThread = ref(false);
const threadRootMsg = ref<TgMessage | null>(null);
const threadMessages = ref<TgMessage[]>([]);
const loadingThread = ref(false);
const threadInputText = ref("");
const sendingThread = ref(false);
const threadEl = ref<HTMLElement | null>(null);

// Context menu for dialog actions
const ctxMenu = ref<{ dialog: TgDialog; x: number; y: number } | null>(null);
// ── Priority request management ───────────────────────────────────────────────
// bgDialogCtrl: the in-flight background 200-dialog fetch -- aborted when the
// user initiates any action so their request gets the connection immediately.
let bgDialogCtrl: AbortController | null = null;
// msgFetchCtrl: the in-flight messages fetch -- aborted if the user switches
// chats before the previous fetch completes.
let msgFetchCtrl: AbortController | null = null;

function cancelBgDialogLoad() {
  bgDialogCtrl?.abort();
  bgDialogCtrl = null;
}

// Kick off (or re-kick) the full 200-dialog background load.
function startBgDialogLoad(accountId: number) {
  cancelBgDialogLoad();
  bgDialogCtrl = new AbortController();
  const ctrl = bgDialogCtrl;
  tgClientApi
    .dialogs(accountId, { limit: 200 }, ctrl.signal)
    .then((allDialogs) => {
      bgDialogCtrl = null;
      if (selectedAccountId.value !== accountId) return;
      const localZeroed = new Set(
        dialogs.value.filter((d) => d.unreadCount === 0).map((d) => d.chatId),
      );
      dialogs.value = allDialogs.map((d) =>
        localZeroed.has(d.chatId) ? { ...d, unreadCount: 0 } : d,
      );
    })
    .catch(() => {
      if (ctrl.signal.aborted) return; // expected cancellation -- not an error
    });
}

let longPressTimer: ReturnType<typeof setTimeout> | null = null;
const tgFolders = ref<TgFolder[]>([]);
const activeFolder = ref<"all" | number>("all");

let liveWs: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsBackoff = 1_000; // ms, doubles on each failure, caps at 30s
let wsAccountId: number | null = null; // account the socket is open for
let wsEverOpen = false; // distinguishes first-open from reconnect
let scrolledToBottom = true;

// ── Computed ──────────────────────────────────────────────────────────────────

const displayedDialogs = computed(() => {
  const base = searchResults.value ?? dialogs.value;
  if (activeFolder.value === "all") return base;

  const folder = tgFolders.value.find((f) => f.id === activeFolder.value);
  if (!folder) return base;

  return base.filter((d) => {
    if (folder.excludedChatIds.includes(d.chatId)) return false;
    if (folder.pinnedChatIds.includes(d.chatId)) return true;
    if (folder.includedChatIds.includes(d.chatId)) return true;
    if (folder.includeBots && d.type === "bot") return true;
    if (
      (folder.includeContacts || folder.includeNonContacts) &&
      d.type === "user"
    )
      return true;
    if (folder.includeGroups && d.type === "group") return true;
    if (folder.includeBroadcasts && d.type === "channel") return true;
    return false;
  });
});

const filteredContacts = computed(() => {
  const q = contactSearch.value.toLowerCase();
  if (!q) return contacts.value;
  return contacts.value.filter((c) =>
    [c.firstName, c.lastName, c.username, c.phone].some((v) =>
      v?.toLowerCase().includes(q),
    ),
  );
});

// Command suggestions: shown while input starts with "/" and no space yet
const commandSuggestions = computed(() => {
  if (!botCommands.value.length) return [];
  const text = inputText.value;
  if (!text.startsWith("/")) return [];
  // Once a space is typed the command word is done -- hide suggestions
  if (text.includes(" ")) return [];
  const query = text.slice(1).toLowerCase();
  if (!query) return botCommands.value;
  return botCommands.value.filter((c) =>
    c.command.toLowerCase().startsWith(query),
  );
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  window.addEventListener("message", handleMiniAppMessage);
  accounts.value = await accountsApi.list().catch(() => []);
  if (!authenticatedAccounts.value.length) return;

  const saved = loadMessengerState();
  const savedAccountValid =
    saved != null &&
    authenticatedAccounts.value.some((a) => a.id === saved.accountId);
  selectedAccountId.value = savedAccountValid
    ? saved.accountId
    : authenticatedAccounts.value[0].id;

  await loadDialogs();
  startLiveSocket();

  // Restore the last open chat -- messages load from cache instantly, new ones sync via WS
  if (savedAccountValid && saved!.dialog) {
    openChat(saved!.dialog);
  }
});

onBeforeUnmount(() => {
  closeLiveSocket();
  stopMembershipPoll();
  window.removeEventListener("message", handleMiniAppMessage);
  if (searchTimer.value) clearTimeout(searchTimer.value);
  _avatarObserver?.disconnect();
  _avatarObserver = null;
});

watch(showContacts, async (val) => {
  if (val && !contacts.value.length) await loadContacts();
});

watch(commandSuggestions, () => {
  selectedCmdIdx.value = -1;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function onDialogContextMenu(e: MouseEvent, dialog: TgDialog) {
  e.preventDefault();
  ctxMenu.value = { dialog, x: e.clientX, y: e.clientY };
}

function onDialogTouchStart(e: TouchEvent, dialog: TgDialog) {
  longPressTimer = setTimeout(() => {
    const t = e.touches[0];
    ctxMenu.value = { dialog, x: t.clientX, y: t.clientY };
  }, 500);
}

function onDialogTouchEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function closeCtx() {
  ctxMenu.value = null;
}

async function ctxMute(secs: number) {
  if (!ctxMenu.value || !selectedAccountId.value) return;
  const { dialog } = ctxMenu.value;
  closeCtx();
  try {
    await tgClientApi.mute(selectedAccountId.value, dialog.chatId, secs);
    copyToast.value = secs === 0 ? "Unmuted" : "Muted";
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToast.value = "";
    }, 2000);
  } catch {
    /* silent */
  }
}

async function ctxPin(pinned: boolean) {
  if (!ctxMenu.value || !selectedAccountId.value) return;
  const { dialog } = ctxMenu.value;
  closeCtx();
  try {
    await tgClientApi.pin(selectedAccountId.value, dialog.chatId, pinned);
    // Move the dialog to top/remove pin marker in local list
    const idx = dialogs.value.findIndex((d) => d.chatId === dialog.chatId);
    if (idx !== -1) {
      const [d] = dialogs.value.splice(idx, 1);
      if (pinned) dialogs.value.unshift(d);
      else dialogs.value.push(d);
    }
    copyToast.value = pinned ? "Pinned" : "Unpinned";
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToast.value = "";
    }, 2000);
  } catch {
    /* silent */
  }
}

// Returns a data URI from the local cache, or '' if not yet loaded.
// Fetches are triggered by the v-avatar-load directive when the element enters the viewport.
function avatarSrc(chatId: string | null): string {
  if (!chatId) return "";
  const data = avatarCache.get(chatId);
  return data ? `data:image/jpeg;base64,${data}` : "";
}

// Enqueues a chatId at the front (high priority) so visible avatars load before off-screen ones.
function enqueueVisibleAvatar(chatId: string): void {
  if (avatarCache.has(chatId) || avatarFetching.has(chatId) || avatarQueued.has(chatId)) return;
  if (!selectedAccountId.value) return;
  avatarQueue.unshift(chatId);
  avatarQueued.add(chatId);
  drainAvatarQueue();
}

let _avatarObserver: IntersectionObserver | null = null;

function getAvatarObserver(): IntersectionObserver {
  if (!_avatarObserver) {
    _avatarObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const chatId = (entry.target as HTMLElement).dataset.avatarChatId;
        if (chatId) {
          _avatarObserver!.unobserve(entry.target);
          enqueueVisibleAvatar(chatId);
        }
      }
    }, { threshold: 0 });
  }
  return _avatarObserver;
}

// Vue directive -- place on the avatar container element with the chatId as binding value.
// Observes the element and triggers a fetch when it scrolls into the viewport.
const vAvatarLoad = {
  mounted(el: HTMLElement, binding: { value: string | null }) {
    if (!binding.value) return;
    el.dataset.avatarChatId = binding.value;
    if (avatarCache.has(binding.value)) return; // already cached -- no need to observe
    getAvatarObserver().observe(el);
  },
  updated(el: HTMLElement, binding: { value: string | null; oldValue: string | null }) {
    if (binding.value === binding.oldValue) return;
    if (!binding.value) return;
    el.dataset.avatarChatId = binding.value;
    if (!avatarCache.has(binding.value)) getAvatarObserver().observe(el);
  },
  unmounted(el: HTMLElement) {
    _avatarObserver?.unobserve(el);
  },
};

function drainAvatarQueue(): void {
  while (avatarConcurrencyState.active < AVATAR_CONCURRENCY && avatarQueue.length > 0) {
    const chatId = avatarQueue.shift()!;
    avatarQueued.delete(chatId);
    // Skip if cached while waiting in queue
    if (avatarCache.has(chatId) || avatarFetching.has(chatId)) continue;
    if (!selectedAccountId.value) { avatarQueue.unshift(chatId); avatarQueued.add(chatId); break; }
    avatarConcurrencyState.active++;
    avatarFetching.add(chatId);
    const accountId = selectedAccountId.value;
    tgClientApi.avatarsBatch(accountId, [chatId])
      .then((result) => { avatarCache.set(chatId, result[chatId] ?? ""); persistAvatarCache(); })
      .catch(() => { avatarCache.set(chatId, ""); })
      .finally(() => {
        avatarFetching.delete(chatId);
        avatarConcurrencyState.active--;
        drainAvatarQueue();
      });
  }
}

async function openProfile() {
  if (!selectedAccountId.value || !activeChat.value) return;
  if (showProfile.value) {
    showProfile.value = false;
    return;
  }
  showProfile.value = true;
  showThread.value = false;
  profileLoading.value = true;
  profileDetails.value = null;
  try {
    profileDetails.value = await tgClientApi.profile(
      selectedAccountId.value,
      activeChat.value.chatId,
    );
  } catch {
    // Fall back to what we already know from the dialog
    if (activeChat.value) {
      profileDetails.value = {
        chatId: activeChat.value.chatId,
        name: activeChat.value.name,
        type: activeChat.value.type,
        username: activeChat.value.username,
        phone: null,
        bio: null,
        memberCount: null,
      };
    }
  } finally {
    profileLoading.value = false;
  }
}

let copyToastTimer: ReturnType<typeof setTimeout> | null = null;

async function copyField(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const el = document.createElement("textarea");
    el.value = value;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  }
  copyToast.value = "Copied!";
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => {
    copyToast.value = "";
  }, 2000);
}

// Open a Telegram URL within the messenger if possible, else fall back to browser.
// Plain t.me/username or t.me/username/123 links are resolved and opened in-app.
// Invite links (t.me/+HASH or t.me/joinchat/HASH) show an in-app join confirmation.
// URLs with query params (?start=, ?startapp=), non-numeric path segments (Mini App paths
// like t.me/bot/app), and non-TG URLs all fall through to the browser.
function escMsgText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

function onMsgLinkClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  e.stopPropagation();
  handleTgUrl(href);
}

function isMiniAppUrl(url: string): boolean {
  return /[?&]startapp=/i.test(url) || /t(?:elegram)?\.me\/\w+\/\w+/i.test(url);
}

// postMessage bridge for the Telegram Mini App SDK
function onWebViewLoad(e: Event) {
  const iframe = e.target as HTMLIFrameElement;
  try {
    iframe.contentWindow?.postMessage(
      JSON.stringify({
        eventType: "viewport_changed",
        eventData: {
          height: iframe.clientHeight,
          is_expanded: true,
          is_state_stable: true,
        },
      }),
      "*",
    );
  } catch {}
}

function handleMiniAppMessage(e: MessageEvent) {
  if (!webViewPanel.value) return;
  let eventType: string | undefined;
  try {
    const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
    eventType = data?.eventType;
  } catch {
    return;
  }
  if (eventType === "web_app_close") webViewPanel.value = null;
  if (eventType === "web_app_ready") {
    // Send theme params so the mini app can match the UI colour scheme
    (e.source as Window)?.postMessage(
      JSON.stringify({
        eventType: "theme_changed",
        eventData: {
          theme_params: {
            bg_color: "#ffffff",
            text_color: "#1a1a2e",
            hint_color: "#999999",
            link_color: "#4361ee",
            button_color: "#4361ee",
            button_text_color: "#ffffff",
            secondary_bg_color: "#f7f8fc",
          },
        },
      }),
      "*",
    );
  }
  if (eventType === "web_app_open_link") {
    try {
      const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      const url = data?.eventData?.url;
      if (url) window.open(url, "_blank", "noopener");
    } catch {}
  }
}

async function openMiniApp(
  url: string,
  title: string,
  botChatId?: string | null,
): Promise<void> {
  if (!selectedAccountId.value) {
    window.open(url, "_blank", "noopener");
    return;
  }
  try {
    const { webAppUrl } = await tgClientApi.webviewResolve(
      selectedAccountId.value,
      url,
      botChatId,
    );
    window.open(webAppUrl, "_blank", "noopener");
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

async function handleTgUrl(url: string) {
  if (!selectedAccountId.value) {
    window.open(url, "_blank", "noopener");
    return;
  }

  // Invite links: t.me/+HASH or t.me/joinchat/HASH
  const inviteM =
    url.match(/https?:\/\/t(?:elegram)?\.me\/\+([A-Za-z0-9_-]+)/i) ??
    url.match(/https?:\/\/t(?:elegram)?\.me\/joinchat\/([A-Za-z0-9_-]+)/i);
  if (inviteM) {
    const hash = inviteM[1];
    checkingInvite.value = true;
    try {
      const preview = await tgClientApi.checkInvite(
        selectedAccountId.value,
        hash,
      );
      if (preview.alreadyJoined && preview.chatId) {
        await openChat({
          chatId: preview.chatId,
          name: preview.title,
          type: preview.type,
          username: null,
          unreadCount: 0,
          lastMessage: null,
        }, true);
      } else {
        invitePreview.value = preview;
      }
    } catch {
      copyToast.value =
        "Could not load group info -- try the official Telegram app";
      if (copyToastTimer) clearTimeout(copyToastTimer);
      copyToastTimer = setTimeout(() => {
        copyToast.value = "";
      }, 4000);
    } finally {
      checkingInvite.value = false;
    }
    return;
  }

  // Mini App links: t.me/bot?startapp=HASH or t.me/bot/appname
  if (isMiniAppUrl(url)) {
    await openMiniApp(url, "Mini App");
    return;
  }

  // Bot deep links: t.me/botname?start=PARAM -- open bot and send the start param
  const startM = url.match(
    /https?:\/\/t(?:elegram)?\.me\/([A-Za-z]\w+)[?&]start=([^&]+)/i,
  );
  if (startM) {
    const [, botUsername, startParam] = startM;
    try {
      const dialog = await tgClientApi.startBot(
        selectedAccountId.value,
        botUsername,
        decodeURIComponent(startParam),
      );
      await openChat(dialog, true);
      // Fetch messages after a short delay so the bot reply is visible
      setTimeout(refreshMessages, 1500);
    } catch (e: any) {
      const raw = e?.response?.data?.error ?? e?.message ?? "Could not start bot";
      copyToast.value = raw;
      if (copyToastTimer) clearTimeout(copyToastTimer);
      copyToastTimer = setTimeout(() => { copyToast.value = ""; }, 4000);
    }
    return;
  }

  // Username or username/messageId links
  const m = url.match(
    /https?:\/\/t(?:elegram)?\.me\/([A-Za-z]\w+)(?:\/(\d+))?(?:[?#].*)?$/i,
  );
  const username = m?.[1];
  if (
    username &&
    username.toLowerCase() !== "joinchat" &&
    username.toLowerCase() !== "s"
  ) {
    try {
      const dialog = await tgClientApi.resolvePeer(
        selectedAccountId.value,
        username,
      );
      await openChat(dialog, true);
      return;
    } catch {
      // Peer not found or resolve failed
    }
  }

  // Never open t.me links in the browser -- show a toast if we couldn't handle it
  if (/https?:\/\/t(?:elegram)?\.me\//i.test(url)) {
    copyToast.value = "Could not open this Telegram link in the messenger";
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => { copyToast.value = ""; }, 4000);
    return;
  }
  window.open(url, "_blank", "noopener");
}

async function confirmJoinInvite() {
  if (!invitePreview.value || !selectedAccountId.value) return;
  joiningInvite.value = true;
  const hash = invitePreview.value.hash;
  try {
    const dialog = await tgClientApi.joinInvite(selectedAccountId.value, hash);
    invitePreview.value = null;
    await openChat(dialog, true);
  } catch (e: any) {
    const raw = e?.response?.data?.error ?? e?.message ?? "Failed to join";
    copyToast.value = friendlyTgError(raw);
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToast.value = "";
    }, 4000);
  } finally {
    joiningInvite.value = false;
  }
}

function stopMembershipPoll() {
  if (membershipPollTimer !== null) {
    clearInterval(membershipPollTimer);
    membershipPollTimer = null;
  }
}

function stopBotMsgWatch() {
  botMsgWatchGen++;
  if (botMsgWatchTimer !== null) {
    clearTimeout(botMsgWatchTimer);
    botMsgWatchTimer = null;
  }
}

// Start polling the active bot chat's last message every 2s until it stops changing.
// Safe to call multiple times -- no-ops if a watch is already scheduled.
function scheduleBotMsgWatch() {
  const lastMsg = messages.value[messages.value.length - 1];
  if (!lastMsg || lastMsg.fromMe || activeChat.value?.type !== 'bot') return;
  if (botMsgWatchTimer !== null) return; // already running

  botMsgWatchText = lastMsg.text;
  botMsgWatchStaleTicks = 0;
  botMsgWatchTotalTicks = 0;
  const gen = ++botMsgWatchGen;

  const tick = async () => {
    if (botMsgWatchGen !== gen) return;
    botMsgWatchTimer = null;

    await refreshMessages();

    if (botMsgWatchGen !== gen) return; // stopped while fetching

    const current = messages.value[messages.value.length - 1];
    if (!current || current.fromMe || activeChat.value?.type !== 'bot') return;

    botMsgWatchTotalTicks++;
    if (current.text === botMsgWatchText) {
      botMsgWatchStaleTicks++;
    } else {
      botMsgWatchText = current.text;
      botMsgWatchStaleTicks = 0;
    }

    // Stop after 3 unchanged polls or 20 total polls (~40s safety cap)
    if (botMsgWatchStaleTicks < 3 && botMsgWatchTotalTicks < 20) {
      botMsgWatchTimer = setTimeout(tick, 2000);
    }
  };

  botMsgWatchTimer = setTimeout(tick, 2000);
}

async function checkMembershipStatus(): Promise<void> {
  if (!selectedAccountId.value || !joinRequestSent.value) return;
  // Use the stored group chatId -- activeChatId may be the verification bot DM, not the group
  const groupChatId = pendingJoinChatId.value ?? activeChatId.value;
  if (!groupChatId) return;
  try {
    const { member } = await tgClientApi.membership(selectedAccountId.value, groupChatId);
    if (member) {
      stopMembershipPoll();
      joinRequestSent.value = false;
      pendingJoinChatId.value = null;
      // Update the group in the dialogs list
      const existing = dialogs.value.find((d) => d.chatId === groupChatId);
      const joined = existing ? { ...existing, left: false } : null;
      if (joined) {
        dialogs.value = dialogs.value.map((d) => (d.chatId === groupChatId ? joined : d));
      }
      // If currently viewing the group, refresh it
      if (activeChatId.value === groupChatId && activeChat.value) {
        activeChat.value = { ...activeChat.value, left: false };
        await fetchMessages(true);
      }
    }
  } catch {
    // silently ignore -- will retry on next poll
  }
}

// After a join request, detect if a verification bot sent a private message and open it.
async function checkForVerificationBot(joinTimeSec: number) {
  if (!joinRequestSent.value || !selectedAccountId.value) return;
  try {
    const fresh = await tgClientApi.dialogs(selectedAccountId.value, { limit: 30 });
    const verifyBot = fresh.find(
      (d) =>
        d.type === "bot" &&
        d.lastMessage !== null &&
        d.lastMessage.date >= joinTimeSec - 5 &&
        d.chatId !== activeChatId.value,
    );
    if (verifyBot) {
      if (!dialogs.value.find((d) => d.chatId === verifyBot.chatId)) {
        dialogs.value.unshift(verifyBot);
      }
      // Save join state -- openChat will clear it
      const savedGroupChatId = pendingJoinChatId.value;
      await openChat(verifyBot, true);
      // Restore join state so the membership poll keeps checking the group
      if (savedGroupChatId) {
        joinRequestSent.value = true;
        pendingJoinChatId.value = savedGroupChatId;
        startMembershipPoll();
      }
    }
  } catch {
    // silently ignore
  }
}

function startMembershipPoll() {
  stopMembershipPoll();
  // Poll every 8 seconds while the join request is pending
  membershipPollTimer = setInterval(checkMembershipStatus, 8_000);
}

async function joinCurrentChat() {
  if (!selectedAccountId.value || !activeChatId.value || !activeChat.value)
    return;
  joiningChannel.value = true;
  try {
    const result = await tgClientApi.join(
      selectedAccountId.value,
      activeChatId.value,
    );
    if (result.requestSent) {
      const joinTimeSec = Math.floor(Date.now() / 1000);
      joinRequestSent.value = true;
      pendingJoinChatId.value = activeChatId.value;
      startMembershipPoll();
      // Initial fetch -- bot may not have replied yet
      await fetchMessages(true);
      // Re-fetch at 2s and 6s so the bot's verification message appears as soon as it arrives
      setTimeout(refreshMessages, 2_000);
      setTimeout(refreshMessages, 6_000);
      // Check if a verification bot sent a private message and open it automatically
      setTimeout(() => checkForVerificationBot(joinTimeSec), 3_000);
      setTimeout(() => checkForVerificationBot(joinTimeSec), 8_000);
    } else {
      const joinTimeSec = Math.floor(Date.now() / 1000);
      const joined = { ...activeChat.value, left: false };
      activeChat.value = joined;
      // Add to dialogs list so the "not-in-dialogs = not a member" heuristic stays correct
      if (!dialogs.value.find((d) => d.chatId === joined.chatId)) {
        dialogs.value.unshift(joined);
      }
      await fetchMessages(true);
      setTimeout(refreshMessages, 2_000);
      // Check if a bot immediately sent a verification private message
      setTimeout(() => checkForVerificationBot(joinTimeSec), 3_000);
    }
  } catch (e: any) {
    const raw = e?.response?.data?.error ?? e?.message ?? "Failed to join";
    copyToast.value = raw;
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToast.value = "";
    }, 4000);
  } finally {
    joiningChannel.value = false;
  }
}

async function clickInlineButton(
  msg: TgMessage,
  btn: {
    text: string;
    data: string | null;
    url: string | null;
    webApp: boolean;
  },
  ri: number,
  bi: number,
) {
  if (!selectedAccountId.value || !activeChatId.value) return;
  const key = `${msg.id}-${ri}-${bi}`;
  if (btn.url) {
    btnLoadingKey.value = key;
    try {
      if (btn.webApp) {
        // Open Mini App inside Bemby -- pass the sender's chatId as the bot context
        await openMiniApp(btn.url, btn.text || "Mini App", msg.fromId);
      } else {
        await handleTgUrl(btn.url);
      }
    } finally {
      btnLoadingKey.value = null;
    }
    return;
  }
  if (!btn.data) return;
  btnLoadingKey.value = key;
  try {
    const res = await tgClientApi.clickButton(
      selectedAccountId.value,
      activeChatId.value,
      msg.id,
      btn.data,
    );
    if (res.message) {
      copyToast.value = res.message;
      if (copyToastTimer) clearTimeout(copyToastTimer);
      copyToastTimer = setTimeout(() => {
        copyToast.value = "";
      }, 4000);
    }
    if (res.url) await handleTgUrl(res.url);
  } catch (e: any) {
    const raw = e?.response?.data?.error ?? e?.message ?? "Button click failed";
    if (raw.includes("MESSAGE_ID_INVALID")) {
      if (joinRequestSent.value && activeChat.value?.left) {
        // Non-member clicking a button in a group they haven't been approved for yet
        copyToast.value = "Complete the verification in the bot's private message first.";
      } else {
        copyToast.value = "Message was updated by the bot -- refreshing...";
        refreshMessages();
      }
    } else if (raw.includes("BOT_RESPONSE_TIMEOUT")) {
      // Bot received the click but didn't answer the callback -- action was likely still processed
    } else {
      copyToast.value = friendlyTgError(raw);
    }
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToast.value = "";
    }, 4000);
  } finally {
    btnLoadingKey.value = null;
    // Re-fetch twice to pick up the bot's immediate edits, then start the watcher
    // for bots that stream/progressively edit their message.
    setTimeout(refreshMessages, 1200);
    setTimeout(() => { refreshMessages(); scheduleBotMsgWatch(); }, 3500);
    // Check membership after bot interaction -- covers both the group view and the bot DM
    if (joinRequestSent.value && pendingJoinChatId.value) {
      setTimeout(checkMembershipStatus, 4000);
    }
  }
}

// Silently re-fetch the latest messages and merge edits/new messages in-place.
async function refreshMessages() {
  if (!selectedAccountId.value || !activeChatId.value) return;
  try {
    const msgs = await tgClientApi.messages(
      selectedAccountId.value,
      activeChatId.value,
      { limit: 20, fresh: 1 },
    );
    const fresh = msgs.reverse(); // oldest first
    if (!fresh.length) return;

    const freshIds = new Set(fresh.map((m) => m.id));
    const oldestFreshId = fresh[0].id;

    // Remove messages the server no longer returns within the fresh ID range --
    // these were deleted by the bot/user after we last loaded them.
    messages.value = messages.value.filter(
      (m) => m.id < oldestFreshId || freshIds.has(m.id),
    );

    let appended = false;
    const lastId = messages.value[messages.value.length - 1]?.id ?? 0;
    for (const msg of fresh) {
      const idx = messages.value.findIndex((m) => m.id === msg.id);
      if (idx !== -1) {
        messages.value[idx] = msg; // update edited messages in-place
      } else if (msg.id > lastId) {
        messages.value.push(msg);
        appended = true;
      }
    }
    if (appended) await scrollBottom(false);

    // Sync the sidebar last-message for this chat -- the bot may have edited it
    const chatId = activeChatId.value;
    const newestMsg = messages.value[messages.value.length - 1];
    if (newestMsg && chatId) {
      const di = dialogs.value.findIndex((d) => d.chatId === chatId);
      if (di !== -1) {
        dialogs.value[di] = {
          ...dialogs.value[di],
          lastMessage: { text: newestMsg.text, date: newestMsg.date, fromMe: newestMsg.fromMe },
        };
      }
    }
  } catch {
    // Silent -- best effort
  }
}

// ── Bot commands ──────────────────────────────────────────────────────────────

async function loadBotCommands(chatId: string) {
  if (!selectedAccountId.value) return;
  try {
    botCommands.value = await tgClientApi.botCommands(
      selectedAccountId.value,
      chatId,
    );
  } catch {
    botCommands.value = [];
  }
}

function openCommandMenu() {
  if (!inputText.value.startsWith("/")) {
    inputText.value = "/";
    autoResize();
  }
  nextTick(() => {
    inputEl.value?.focus();
    const el = inputEl.value;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  });
}

function selectCommand(cmd: TgBotCommand) {
  inputText.value = `/${cmd.command} `;
  autoResize();
  nextTick(() => {
    inputEl.value?.focus();
    const el = inputEl.value;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  });
}

function showToast(msg: string, ms = 3000) {
  copyToast.value = msg;
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => {
    copyToast.value = "";
  }, ms);
}

// ── Reply ─────────────────────────────────────────────────────────────────────

function startReply(msg: TgMessage) {
  replyingTo.value = msg;
  nextTick(() => inputEl.value?.focus());
}

function scrollToReply(replyToId: number) {
  const el = messagesEl.value;
  if (!el) return;
  const target = el.querySelector(`[data-msg-id="${replyToId}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("tgc-msg-highlighted");
  setTimeout(() => target.classList.remove("tgc-msg-highlighted"), 1500);
}

// ── Reactions ─────────────────────────────────────────────────────────────────

function openReactPicker(msg: TgMessage, e: MouseEvent) {
  e.stopPropagation();
  emojiPickerMsgId.value = msg.id;
  const btn = e.currentTarget as HTMLElement;
  const rect = btn.getBoundingClientRect();
  emojiPickerPos.value = { x: rect.left - 40, y: rect.top };
}

async function doReact(msgId: number, emoji: string) {
  if (!selectedAccountId.value || !activeChatId.value) return;
  const msg =
    messages.value.find((m) => m.id === msgId) ??
    threadMessages.value.find((m) => m.id === msgId);
  const existing = msg?.reactions?.find((r) => r.emoji === emoji);
  const sendEmoji = existing?.mine ? null : emoji;
  try {
    await tgClientApi.sendReaction(
      selectedAccountId.value,
      activeChatId.value,
      msgId,
      sendEmoji,
    );
    // Optimistic update
    if (msg) {
      if (sendEmoji) {
        if (existing) {
          existing.mine = true;
          existing.count++;
        } else {
          if (!msg.reactions) msg.reactions = [];
          msg.reactions.push({ emoji, count: 1, mine: true });
        }
      } else if (existing) {
        existing.mine = false;
        existing.count = Math.max(0, existing.count - 1);
        msg.reactions = msg.reactions!.filter((r) => r.count > 0);
        if (!msg.reactions.length) msg.reactions = null;
      }
    }
    setTimeout(refreshMessages, 1500);
  } catch (e: any) {
    showToast(e?.response?.data?.error ?? e?.message ?? "Failed to react");
  }
}

async function pickReaction(emoji: string) {
  const msgId = emojiPickerMsgId.value;
  emojiPickerMsgId.value = null;
  if (msgId === null) return;
  await doReact(msgId, emoji);
}

// ── Thread / comments ─────────────────────────────────────────────────────────

async function openThread(msg: TgMessage) {
  if (!selectedAccountId.value || !activeChatId.value) return;
  threadRootMsg.value = msg;
  showThread.value = true;
  showProfile.value = false;
  loadingThread.value = true;
  threadMessages.value = [];
  try {
    const msgs = await tgClientApi.threadMessages(
      selectedAccountId.value,
      activeChatId.value,
      msg.id,
    );
    threadMessages.value = msgs.reverse();
    await nextTick();
    if (threadEl.value) threadEl.value.scrollTop = threadEl.value.scrollHeight;
  } catch (e: any) {
    showToast(
      e?.response?.data?.error ?? e?.message ?? "Failed to load thread",
    );
  } finally {
    loadingThread.value = false;
  }
}

async function sendThreadMessage() {
  const text = threadInputText.value.trim();
  if (
    !text ||
    !selectedAccountId.value ||
    !activeChatId.value ||
    !threadRootMsg.value ||
    sendingThread.value
  )
    return;
  sendingThread.value = true;
  threadInputText.value = "";
  try {
    const result = await tgClientApi.send(
      selectedAccountId.value,
      activeChatId.value,
      text,
      threadRootMsg.value.id,
    );
    threadMessages.value.push({
      id: result.id,
      text,
      html: null,
      date: result.date,
      fromMe: true,
      fromId: null,
      fromName: null,
      hasPhoto: false,
      hasDocument: false,
      buttons: null,
      reactions: null,
      replyToId: threadRootMsg.value.id,
      replyToText: threadRootMsg.value.text,
      replyToName: null,
      replyCount: null,
    });
    await nextTick();
    if (threadEl.value) threadEl.value.scrollTop = threadEl.value.scrollHeight;
    // Update reply count on root message
    const root = messages.value.find((m) => m.id === threadRootMsg.value!.id);
    if (root && root.replyCount !== null) root.replyCount++;
  } catch (e: any) {
    showToast(e?.response?.data?.error ?? e?.message ?? "Failed to send reply");
  } finally {
    sendingThread.value = false;
  }
}

function avatarLetter(name: string) {
  return (name || "?").trim()[0].toUpperCase();
}

const SENDER_COLOURS = [
  "#4361ee",
  "#e63946",
  "#2ec4b6",
  "#f4a261",
  "#7209b7",
  "#118ab2",
  "#06d6a0",
  "#ff6b6b",
];

function senderColor(fromId: string | null): string {
  if (!fromId) return SENDER_COLOURS[0];
  let h = 0;
  for (let i = 0; i < fromId.length; i++)
    h = ((h << 5) - h + fromId.charCodeAt(i)) | 0;
  return SENDER_COLOURS[Math.abs(h) % SENDER_COLOURS.length];
}

function showSenderAvatar(idx: number): boolean {
  const msg = messages.value[idx];
  // Only show in groups with a known sender; channels post as the channel itself (no fromId)
  if (msg.fromMe || !msg.fromId) return false;
  const chat = activeChat.value;
  if (!chat || chat.type !== "group") return false;
  const next = messages.value[idx + 1];
  return !next || next.fromMe || next.fromId !== msg.fromId;
}

function fmtTime(ts: number) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 0)
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
}

function fmtMsgTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString([], {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function sameDay(a: number, b: number) {
  const da = new Date(a * 1000);
  const db = new Date(b * 1000);
  return da.toDateString() === db.toDateString();
}

function photoUrl(msgId: number) {
  if (!selectedAccountId.value || !activeChatId.value) return "";
  return tgClientApi.photoUrl(
    selectedAccountId.value,
    activeChatId.value,
    msgId,
  );
}

async function scrollBottom(force = false) {
  if (!scrolledToBottom && !force) return;
  await nextTick();
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  }
}

// Scroll to the first unread message when opening a chat with unread messages.
// Falls back to scrolling to the bottom when all loaded messages are unread
// (meaning there are more unread messages further back) or when there are none.
async function scrollToUnread(unreadCount: number): Promise<void> {
  await nextTick();
  const el = messagesEl.value;
  if (!el) return;
  if (!firstUnreadId.value) {
    el.scrollTop = el.scrollHeight;
    return;
  }
  const target = el.querySelector(
    `[data-msg-id="${firstUnreadId.value}"]`,
  ) as HTMLElement | null;
  if (target) {
    el.scrollTop = target.offsetTop - el.offsetTop - 60;
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

function onMsgScroll() {
  const el = messagesEl.value;
  if (!el) return;
  scrolledToBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  if (el.scrollTop <= 60 && canLoadMore.value && !loadingOlder.value && messages.value.length >= 30) {
    loadOlderMessages();
  }
}

function autoResize() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

// ── Account change ────────────────────────────────────────────────────────────

async function onAccountChange() {
  closeLiveSocket();
  dialogs.value = [];
  activeChatId.value = null;
  activeChat.value = null;
  messages.value = [];
  contacts.value = [];
  searchQuery.value = "";
  searchResults.value = null;
  showMobileChat.value = false;
  activeFolder.value = "all";
  tgFolders.value = [];
  showThread.value = false;
  replyingTo.value = null;
  botCommands.value = [];
  saveMessengerState();
  await loadDialogs();
  startLiveSocket();
}

// ── Dialogs ───────────────────────────────────────────────────────────────────

// Maps raw Telegram API error strings to human-readable guidance.
function friendlyTgError(raw: string): string {
  if (raw.includes("AUTH_KEY_DUPLICATED"))
    return "Session conflict: this account is already connected elsewhere. Click Reconnect to fix this.";
  if (raw.includes("AUTH_KEY_INVALID") || raw.includes("AUTH_KEY_UNREGISTERED"))
    return "Session is no longer valid. Click Reconnect or re-authenticate this account.";
  if (raw.includes("SESSION_REVOKED") || raw.includes("SESSION_EXPIRED"))
    return "This session was revoked (e.g. via Telegram Settings > Devices). Please reconnect.";
  if (raw.includes("USER_DEACTIVATED"))
    return "This Telegram account has been deactivated.";
  if (raw.includes("FLOOD_WAIT"))
    return "Too many requests -- Telegram has asked us to slow down. Please wait a moment and try again.";
  if (raw.includes("PHONE_NUMBER_BANNED"))
    return "This phone number is banned from Telegram.";
  if (
    raw.includes("CONNECTION") ||
    raw.includes("NETWORK") ||
    raw.includes("ECONNREFUSED")
  )
    return "Network error connecting to Telegram. Check your server connection and try again.";
  return raw;
}

// Returns true for errors that a reconnect can potentially fix.
function isAuthError(raw: string): boolean {
  return (
    raw.includes("AUTH_KEY_DUPLICATED") ||
    raw.includes("AUTH_KEY_INVALID") ||
    raw.includes("AUTH_KEY_UNREGISTERED") ||
    raw.includes("SESSION_REVOKED") ||
    raw.includes("SESSION_EXPIRED")
  );
}

async function reconnectAccount() {
  if (!selectedAccountId.value || reconnecting.value) return;
  reconnecting.value = true;
  dialogError.value = "";
  try {
    await tgClientApi.reconnect(selectedAccountId.value);
    await loadDialogs();
  } catch (e: any) {
    dialogError.value = friendlyTgError(
      e?.response?.data?.error ?? e?.message ?? "Reconnect failed",
    );
  } finally {
    reconnecting.value = false;
  }
}

async function loadDialogs() {
  if (!selectedAccountId.value) return;
  loadingDialogs.value = true;
  dialogError.value = "";
  const accountId = selectedAccountId.value;
  try {
    // Load first 30 and folders in parallel -- show UI immediately
    const [firstBatch, folders] = await Promise.all([
      tgClientApi.dialogs(accountId, { limit: 200 }),
      tgClientApi.folders(accountId).catch(() => []),
    ]);
    // Only apply if the account hasn't changed while we were waiting
    if (selectedAccountId.value !== accountId) return;
    dialogs.value = firstBatch;
    tgFolders.value = folders;
    loadingDialogs.value = false;

  } catch (e: any) {
    const raw =
      e?.response?.data?.error ?? e?.message ?? "Failed to load chats";
    dialogError.value = friendlyTgError(raw);
    loadingDialogs.value = false;
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

function onSearchInput() {
  if (searchTimer.value) clearTimeout(searchTimer.value);
  const q = searchQuery.value.trim();
  if (!q) {
    searchResults.value = null;
    return;
  }

  // First filter local dialogs immediately
  searchResults.value = dialogs.value.filter(
    (d) =>
      d.name.toLowerCase().includes(q.toLowerCase()) ||
      d.username?.toLowerCase().includes(q.toLowerCase()),
  );

  // Then fetch from Telegram after debounce
  searchTimer.value = setTimeout(async () => {
    if (!selectedAccountId.value) return;
    try {
      const remote = await tgClientApi.search(selectedAccountId.value, q);
      // Merge remote results, dedup by chatId
      const seen = new Set(searchResults.value?.map((d) => d.chatId));
      const merged = [...(searchResults.value ?? [])];
      for (const r of remote) {
        if (!seen.has(r.chatId)) merged.push(r);
      }
      searchResults.value = merged;
    } catch {
      /* silently ignore search errors */
    }
  }, 500);
}

// ── Chat ──────────────────────────────────────────────────────────────────────

async function openChat(dialog: TgDialog, addToHistory = false) {
  // Cancel the background dialog load so this request gets the connection first
  cancelBgDialogLoad();
  // Prefer fresh dialog data from the loaded list (has accurate unreadCount)
  const fresh = dialogs.value.find((d) => d.chatId === dialog.chatId);
  let dlg = fresh ?? dialog;

  // Channels/groups not in the subscribed dialogs list = user is not a member.
  // The Telegram API only sets `left: true` when the user explicitly left; for channels
  // never joined the flag is absent, so Boolean(c.left) returns false incorrectly.
  // Dialogs list contains only subscribed chats, so absence there is the reliable signal.
  if (
    !fresh &&
    dialogs.value.length > 0 &&
    (dlg.type === "channel" || dlg.type === "group")
  ) {
    dlg = { ...dlg, left: true };
  }

  if (addToHistory && activeChat.value && activeChat.value.chatId !== dlg.chatId) {
    chatNavStack.value.push(activeChat.value);
  } else if (!addToHistory) {
    chatNavStack.value = [];
  }
  activeChatId.value = dlg.chatId;
  activeChat.value = dlg;
  saveMessengerState();
  messages.value = [];
  firstUnreadId.value = null;
  canLoadMore.value = true;
  scrolledToBottom = true;
  showMobileChat.value = true;
  showProfile.value = false;
  profileDetails.value = null;
  showThread.value = false;
  threadRootMsg.value = null;
  replyingTo.value = null;
  botCommands.value = [];
  joinRequestSent.value = false;
  pendingJoinChatId.value = null;
  stopMembershipPoll();
  stopBotMsgWatch();
  pinnedMsg.value = null;
  await fetchMessages();
  markChatRead(dlg.chatId);
  if (dlg.type === "bot") loadBotCommands(dlg.chatId);
  loadPinnedMessage(); // fire-and-forget -- no need to block chat open
  // Resume background dialog load 2s after messages are shown -- low priority
  if (selectedAccountId.value) {
    const accountId = selectedAccountId.value;
    setTimeout(() => startBgDialogLoad(accountId), 2000);
  }
  await nextTick();
  inputEl.value?.focus();
}

function markChatRead(chatId: string) {
  if (!selectedAccountId.value || !messages.value.length) return;
  const maxId = Math.max(...messages.value.map((m) => m.id));

  // Clear badge immediately in UI
  firstUnreadId.value = null;
  const idx = dialogs.value.findIndex((d) => d.chatId === chatId);
  if (idx !== -1)
    dialogs.value[idx] = { ...dialogs.value[idx], unreadCount: 0 };

  // Coalesce into one request per chat -- same chat just bumps maxId and waits
  if (markReadPending?.chatId === chatId) {
    markReadPending.maxId = Math.max(markReadPending.maxId, maxId);
    return;
  }

  // Different chat -- flush pending immediately before starting a new timer
  if (markReadPending && markReadTimer) {
    clearTimeout(markReadTimer);
    markReadTimer = null;
    tgClientApi.markRead(selectedAccountId.value, markReadPending.chatId, markReadPending.maxId).catch(() => {});
  }

  markReadPending = { chatId, maxId };
  markReadTimer = setTimeout(() => {
    markReadTimer = null;
    if (markReadPending && selectedAccountId.value) {
      tgClientApi.markRead(selectedAccountId.value, markReadPending.chatId, markReadPending.maxId).catch(() => {});
      markReadPending = null;
    }
  }, 2000);
}

async function clearChatCache() {
  if (!selectedAccountId.value || !activeChatId.value) return;
  await tgClientApi.clearCache(selectedAccountId.value, activeChatId.value);
  await fetchMessages(true);
}

async function loadPinnedMessage() {
  if (!selectedAccountId.value || !activeChatId.value) return;
  const chat = activeChat.value;
  if (!chat || (chat.type !== 'group' && chat.type !== 'channel')) {
    pinnedMsg.value = null;
    return;
  }
  try {
    pinnedMsg.value = await tgClientApi.pinnedMessage(selectedAccountId.value, activeChatId.value);
  } catch {
    pinnedMsg.value = null;
  }
}

async function jumpToPinned() {
  if (!pinnedMsg.value || !selectedAccountId.value || !activeChatId.value) return;
  const id = pinnedMsg.value.id;
  const inView = messages.value.find((m) => m.id === id);
  if (inView) {
    await nextTick();
    const el = messagesEl.value;
    if (!el) return;
    const target = el.querySelector(`[data-msg-id="${id}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('tgc-msg-highlighted');
      setTimeout(() => target.classList.remove('tgc-msg-highlighted'), 1500);
    }
    return;
  }
  // Message not in current view -- load context around the pinned message AND
  // the recent messages so the user can still scroll down to the latest.
  const [aroundMsgs, recentMsgs] = await Promise.all([
    tgClientApi.messages(selectedAccountId.value, activeChatId.value, {
      limit: 30, offsetId: id + 1, fresh: 1,
    }),
    tgClientApi.messages(selectedAccountId.value, activeChatId.value, {
      limit: 30, fresh: 1,
    }),
  ]);

  // Merge and deduplicate, keep chronological order
  const byId = new Map<number, TgMessage>();
  for (const m of [...aroundMsgs, ...recentMsgs]) byId.set(m.id, m);
  messages.value = Array.from(byId.values()).sort((a, b) => a.id - b.id);
  canLoadMore.value = true;

  await nextTick();
  const el = messagesEl.value;
  if (!el) return;
  const target = el.querySelector(`[data-msg-id="${id}"]`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('tgc-msg-highlighted');
    setTimeout(() => target.classList.remove('tgc-msg-highlighted'), 1500);
  }
}

async function backToDialogs() {
  const prev = chatNavStack.value.pop();
  if (prev) {
    const remainingStack = [...chatNavStack.value];
    // Save before openChat clears join state
    const savedPendingId = pendingJoinChatId.value;
    await openChat(prev);
    chatNavStack.value = remainingStack;
    // If navigating back to the group that has a pending join, restore the pending state
    if (savedPendingId && prev.chatId === savedPendingId) {
      joinRequestSent.value = true;
      pendingJoinChatId.value = savedPendingId;
      startMembershipPoll();
    }
  } else {
    // No nav history -- on mobile this returns to the dialog list; on desktop it's a no-op
    showMobileChat.value = false;
  }
}

function closeChat() {
  const prev = chatNavStack.value.pop();
  if (prev) {
    // Has history -- navigate back (same as Back button)
    const remainingStack = [...chatNavStack.value];
    const savedPendingId = pendingJoinChatId.value;
    openChat(prev).then(() => {
      chatNavStack.value = remainingStack;
      if (savedPendingId && prev.chatId === savedPendingId) {
        joinRequestSent.value = true;
        pendingJoinChatId.value = savedPendingId;
        startMembershipPoll();
      }
    });
  } else {
    // No history -- fully deselect the chat
    showMobileChat.value = false;
    activeChatId.value = null;
    activeChat.value = null;
    messages.value = [];
    pinnedMsg.value = null;
    stopBotMsgWatch();
    stopMembershipPoll();
  }
}

async function fetchMessages(fresh = false) {
  if (!selectedAccountId.value || !activeChatId.value) return;
  // Cancel any in-flight fetch (user switched chats before previous one finished)
  msgFetchCtrl?.abort();
  msgFetchCtrl = new AbortController();
  const ctrl = msgFetchCtrl;
  const chatId = activeChatId.value;
  const unreadCount = activeChat.value?.unreadCount ?? 0;

  loadingMessages.value = true;
  try {
    const msgs = await tgClientApi.messages(
      selectedAccountId.value,
      chatId,
      { limit: 30, ...(fresh ? { fresh: 1 } : {}) },
      ctrl.signal,
    );
    if (ctrl.signal.aborted || activeChatId.value !== chatId) return;
    messages.value = msgs.reverse();
    if (msgs.length < 30) canLoadMore.value = false;

    // Tell the backend which chat is active so it can periodically sync new messages
    if (liveWs && liveWs.readyState === WebSocket.OPEN) {
      liveWs.send(JSON.stringify({ type: "activateChat", chatId }));
    }

    // Mark the first unread message so we can scroll to it and show a divider
    if (unreadCount > 0 && unreadCount < messages.value.length) {
      firstUnreadId.value =
        messages.value[messages.value.length - unreadCount].id;
    } else {
      firstUnreadId.value = null;
    }
    await scrollToUnread(unreadCount);
    scheduleBotMsgWatch();
  } catch (e: any) {
    if (ctrl.signal.aborted) return;
    console.error("Failed to load messages:", e);
  } finally {
    // Only clear the spinner if this is still the active fetch
    if (msgFetchCtrl === ctrl) {
      loadingMessages.value = false;
      msgFetchCtrl = null;
    }
  }
}

async function loadOlderMessages() {
  if (!selectedAccountId.value || !activeChatId.value || !messages.value.length)
    return;
  loadingOlder.value = true;
  const oldestId = messages.value[0].id;
  const el = messagesEl.value;
  const prevScrollHeight = el?.scrollHeight ?? 0;
  try {
    const older = await tgClientApi.messages(
      selectedAccountId.value,
      activeChatId.value,
      {
        limit: 50,
        offsetId: oldestId,
      },
    );
    if (older.length < 50) canLoadMore.value = false;
    messages.value = [...older.reverse(), ...messages.value];
    await nextTick();
    // Preserve scroll position after prepend
    if (el) el.scrollTop = el.scrollHeight - prevScrollHeight;
  } catch (e: any) {
    console.error("Failed to load older messages:", e);
  } finally {
    loadingOlder.value = false;
  }
}

function onComposeKey(e: KeyboardEvent) {
  // Command suggestion keyboard navigation
  if (commandSuggestions.value.length) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedCmdIdx.value = Math.max(0, selectedCmdIdx.value - 1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedCmdIdx.value = Math.min(
        commandSuggestions.value.length - 1,
        selectedCmdIdx.value + 1,
      );
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const idx = selectedCmdIdx.value >= 0 ? selectedCmdIdx.value : 0;
      const cmd = commandSuggestions.value[idx];
      if (cmd) selectCommand(cmd);
      return;
    }
    if (e.key === "Enter" && selectedCmdIdx.value >= 0) {
      e.preventDefault();
      selectCommand(commandSuggestions.value[selectedCmdIdx.value]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      inputText.value = "";
      return;
    }
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

async function sendMessage() {
  const text = inputText.value.trim();
  if (!text || !selectedAccountId.value || !activeChatId.value || sending.value)
    return;
  sending.value = true;
  const replyMsg = replyingTo.value;
  inputText.value = "";
  replyingTo.value = null;
  if (inputEl.value) {
    inputEl.value.style.height = "auto";
  }
  try {
    const result = await tgClientApi.send(
      selectedAccountId.value,
      activeChatId.value,
      text,
      replyMsg?.id,
    );
    // Optimistically append
    messages.value.push({
      id: result.id,
      text,
      html: null,
      date: result.date,
      fromMe: true,
      fromId: null,
      fromName: null,
      hasPhoto: false,
      hasDocument: false,
      buttons: null,
      reactions: null,
      replyToId: replyMsg?.id ?? null,
      replyToText: replyMsg?.text ?? null,
      replyToName: null,
      replyCount: null,
    });
    await scrollBottom(true);
    // Update dialog preview
    const idx = dialogs.value.findIndex((d) => d.chatId === activeChatId.value);
    if (idx !== -1) {
      dialogs.value[idx] = {
        ...dialogs.value[idx],
        lastMessage: { text, date: result.date, fromMe: true },
      };
      // Sort dialog to top
      const [moved] = dialogs.value.splice(idx, 1);
      dialogs.value.unshift(moved);
    }
  } catch (e: any) {
    console.error("Send failed:", e);
  } finally {
    sending.value = false;
    await nextTick();
    inputEl.value?.focus();
  }
}

// ── WebSocket live connection ─────────────────────────────────────────────────

function closeLiveSocket() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  liveWs?.close();
  liveWs = null;
  wsAccountId = null;
  wsEverOpen = false;
  wsBackoff = 1_000;
}

function startLiveSocket() {
  if (!selectedAccountId.value) return;
  // Cancel any pending reconnect before starting a fresh connection
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  liveWs?.close();

  const accountId = selectedAccountId.value;
  wsAccountId = accountId;
  const token = localStorage.getItem("token") ?? "";
  // Derive ws(s):// from the current page origin
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(
    `${proto}://${location.host}/ws?accountId=${accountId}&token=${encodeURIComponent(token)}`,
  );
  liveWs = ws;

  ws.onopen = () => {
    wsBackoff = 1_000; // reset backoff after a successful connection
    if (wsEverOpen) {
      // Reconnected after a drop -- catch up on missed messages
      catchUpActiveChatMessages();
    }
    wsEverOpen = true;
    // Re-register active chat so the backend resumes periodic sync
    if (activeChatId.value) {
      ws.send(
        JSON.stringify({ type: "activateChat", chatId: activeChatId.value }),
      );
    }
  };

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data as string);
      if (data.type === "message")
        onIncomingMessage(data.chatId as string, data.message as TgMessage);
      else if (data.type === "dialogs" && Array.isArray(data.dialogs)) {
        const updated = data.dialogs as TgDialog[];
        dialogs.value = updated;
      }
    } catch {
      /* ignore parse errors */
    }
  };

  ws.onclose = () => {
    if (wsAccountId !== accountId) return; // account changed -- don't reconnect
    // Exponential backoff reconnect, capped at 30 s
    wsReconnectTimer = setTimeout(() => {
      wsBackoff = Math.min(wsBackoff * 2, 30_000);
      startLiveSocket();
    }, wsBackoff);
  };

  ws.onerror = () => {
    // onclose fires right after -- reconnect logic lives there
  };
}

// On reconnect, silently append any messages that arrived while the socket was down.
async function catchUpActiveChatMessages(): Promise<void> {
  if (!selectedAccountId.value || !activeChatId.value || !messages.value.length)
    return;
  const newestId = Math.max(...messages.value.map((m) => m.id));
  try {
    const fresh = await tgClientApi.messages(
      selectedAccountId.value,
      activeChatId.value,
      { limit: 50 },
    );
    const newMsgs = fresh.filter((m) => m.id > newestId).reverse(); // oldest-first
    for (const msg of newMsgs) {
      if (!messages.value.find((m) => m.id === msg.id))
        messages.value.push(msg);
    }
    if (newMsgs.length) await scrollBottom(true);
  } catch {
    // Best effort -- non-critical
  }
}

function onIncomingMessage(chatId: string, msg: TgMessage) {
  // Update dialog preview
  const idx = dialogs.value.findIndex((d) => d.chatId === chatId);
  if (idx !== -1) {
    const updated = {
      ...dialogs.value[idx],
      lastMessage: { text: msg.text, date: msg.date, fromMe: false },
    };
    if (!msg.fromMe && chatId !== activeChatId.value)
      updated.unreadCount = (updated.unreadCount ?? 0) + 1;
    dialogs.value.splice(idx, 1);
    dialogs.value.unshift(updated);
  }

  // Append to open chat
  if (chatId === activeChatId.value) {
    // Avoid duplicate if already optimistically appended
    if (!messages.value.find((m) => m.id === msg.id)) {
      messages.value.push(msg);
      scrollBottom();
    }
    // Mark as read on TG server and clear local badge
    markChatRead(chatId);
    // If a bot sent this message it may keep editing it -- start the watcher
    if (!msg.fromMe) scheduleBotMsgWatch();
  }
}

// ── Contacts ──────────────────────────────────────────────────────────────────

async function loadContacts() {
  if (!selectedAccountId.value) return;
  loadingContacts.value = true;
  try {
    contacts.value = await tgClientApi.contacts(selectedAccountId.value);
  } catch (e: any) {
    console.error("Failed to load contacts:", e);
  } finally {
    loadingContacts.value = false;
  }
}

function openContactChat(c: TgContact) {
  showContacts.value = false;
  const existing = dialogs.value.find((d) => d.chatId === c.chatId);
  if (existing) {
    openChat(existing);
  } else {
    // Create a synthetic dialog entry for this contact
    const synthetic: TgDialog = {
      chatId: c.chatId,
      name:
        [c.firstName, c.lastName].filter(Boolean).join(" ") ||
        c.username ||
        c.phone ||
        "Unknown",
      type: "user",
      username: c.username,
      unreadCount: 0,
      lastMessage: null,
    };
    dialogs.value.unshift(synthetic);
    openChat(synthetic);
  }
}

async function addContactSubmit() {
  if (!selectedAccountId.value) return;
  addContactError.value = "";
  addContactOk.value = false;
  addingContact.value = true;
  try {
    const c = await tgClientApi.addContact(
      selectedAccountId.value,
      newPhone.value.trim(),
      newFirstName.value.trim(),
    );
    contacts.value.unshift(c);
    newPhone.value = "";
    newFirstName.value = "";
    addContactOk.value = true;
    setTimeout(() => {
      addContactOk.value = false;
    }, 3000);
  } catch (e: any) {
    addContactError.value =
      e?.response?.data?.error ?? e.message ?? "Failed to add contact";
  } finally {
    addingContact.value = false;
  }
}
</script>

<style scoped>
/* ── Overlay (desktop popup mode) ───────────────────────────────────────────── */
.tgc-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

/* ── Inline mode (mobile full-page) ─────────────────────────────────────────── */
.tgc-inline-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.tgc-popup-inline {
  height: 100% !important;
  max-height: none !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  width: 100% !important;
}

.tgc-popup {
  background: #fff;
  border-radius: 10px;
  width: 100%;
  max-width: none;
  height: calc(100vh - 32px);
  max-height: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
  position: relative;
}

/* ── Header ─────────────────────────────────────────────────────────────────── */
.tgc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #e8e9ed;
  flex-shrink: 0;
  gap: 10px;
  background: #fff;
}

.tgc-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tgc-header-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.tgc-logo {
  color: #4361ee;
  flex-shrink: 0;
}

.tgc-title {
  font-weight: 600;
  font-size: 15px;
  white-space: nowrap;
  color: #1a1a2e;
}

.tgc-account-select {
  background: #f5f6fa;
  border: 1px solid #e0e0e8;
  color: #1a1a2e;
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 13px;
  max-width: 180px;
  cursor: pointer;
  outline: none;
}

.tgc-icon-btn {
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 15px;
  transition:
    background 0.15s,
    color 0.15s;
}

.tgc-icon-btn:hover {
  background: #f0f2f5;
  color: #1a1a2e;
}

.tgc-close-btn:hover {
  background: #fee2e2;
  color: #e63946;
}

/* ── Body ───────────────────────────────────────────────────────────────────── */
.tgc-body {
  display: flex;
  flex: 1;
  overflow: hidden;
  background: #fff;
}

/* ── Sidebar ────────────────────────────────────────────────────────────────── */
.tgc-sidebar {
  width: 290px;
  flex-shrink: 0;
  border-right: 1px solid #e8e9ed;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #f8f9fb;
}

.tgc-search-wrap {
  position: relative;
  padding: 10px 12px 8px;
  flex-shrink: 0;
  background: #f8f9fb;
}

.tgc-search-icon {
  position: absolute;
  left: 22px;
  top: 50%;
  transform: translateY(-50%);
  color: #aaa;
  font-size: 12px;
  pointer-events: none;
}

.tgc-search-input {
  width: 100%;
  background: #fff;
  border: 1px solid #dde0e8;
  border-radius: 20px;
  padding: 6px 28px 6px 30px;
  font-size: 13px;
  color: #1a1a2e;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}

.tgc-search-input:focus {
  border-color: #4361ee;
}

.tgc-search-clear {
  position: absolute;
  right: 22px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: #aaa;
  cursor: pointer;
  padding: 2px;
  font-size: 12px;
}

/* ── Folder tabs ────────────────────────────────────────────────────────────── */
.tgc-folder-tabs-wrap {
  position: relative;
  flex-shrink: 0;
}

/* Fade-out on the right to hint at hidden tabs */
.tgc-folder-tabs-wrap::after {
  content: "";
  position: absolute;
  top: 0;
  right: 0;
  bottom: 8px;
  width: 24px;
  background: linear-gradient(to right, transparent, #f8f9fb);
  pointer-events: none;
}

.tgc-folder-tabs {
  display: flex;
  gap: 6px;
  padding: 0 12px 8px;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: #dde0e8 transparent;
  flex-shrink: 0;
}

.tgc-folder-tabs::-webkit-scrollbar {
  height: 3px;
}

.tgc-folder-tabs::-webkit-scrollbar-thumb {
  background: #dde0e8;
  border-radius: 2px;
}

.tgc-folder-tab {
  background: none;
  border: 1px solid #dde0e8;
  border-radius: 16px;
  padding: 3px 12px;
  font-size: 12px;
  color: #666;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}

.tgc-folder-tab:hover {
  background: #eef0f6;
}

.tgc-folder-tab.active {
  background: #4361ee;
  border-color: #4361ee;
  color: #fff;
  font-weight: 500;
}

.tgc-dialog-list {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
}

.tgc-dialog-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.1s;
  min-height: 60px;
}

.tgc-dialog-item:hover {
  background: #eef0f6;
}

.tgc-dialog-item.active {
  background: #dce3ff;
}

.tgc-dialog-info {
  flex: 1;
  min-width: 0;
}

.tgc-dialog-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
}

.tgc-dialog-name {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #1a1a2e;
  flex: 1;
  min-width: 0;
}

.tgc-dialog-time {
  font-size: 11px;
  color: #999;
  flex-shrink: 0;
}

.tgc-dialog-preview {
  font-size: 12px;
  color: #999;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.tgc-unread-badge {
  background: #4361ee;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  border-radius: 10px;
  padding: 1px 6px;
  flex-shrink: 0;
}

/* ── Avatar ─────────────────────────────────────────────────────────────────── */
.tgc-avatar {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  font-weight: 600;
  flex-shrink: 0;
  color: #fff;
}

.tgc-avatar-sm {
  width: 34px;
  height: 34px;
  font-size: 14px;
}

.tgc-avatar-user {
  background: #4a90e2;
}
.tgc-avatar-bot {
  background: #7c4dff;
}
.tgc-avatar-group {
  background: #26a69a;
}
.tgc-avatar-channel {
  background: #ef6c00;
}

/* ── Chat panel ─────────────────────────────────────────────────────────────── */
.tgc-chat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
  position: relative;
}

.tgc-chat-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid #e8e9ed;
  flex-shrink: 0;
  background: #fff;
}

.tgc-chat-title-wrap {
  min-width: 0;
  flex: 1;
}

.tgc-chat-name {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #1a1a2e;
}

.tgc-chat-sub {
  font-size: 12px;
  color: #999;
}

.tgc-pinned-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 16px;
  background: #f0f4ff;
  border-bottom: 1px solid #dce3f5;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s;
}
.tgc-pinned-bar:hover {
  background: #e4ecff;
}
.tgc-pinned-icon {
  color: #5c7cfa;
  font-size: 13px;
  flex-shrink: 0;
  transform: rotate(45deg);
}
.tgc-pinned-content {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.tgc-pinned-label {
  font-size: 11px;
  font-weight: 600;
  color: #5c7cfa;
  line-height: 1.2;
}
.tgc-pinned-text {
  font-size: 13px;
  color: #444;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tgc-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: #f5f7fb;
}

/* ── Messages ───────────────────────────────────────────────────────────────── */
.tgc-date-sep {
  text-align: center;
  font-size: 12px;
  color: #999;
  margin: 12px 0 6px;
  position: relative;
}

.tgc-date-sep::before,
.tgc-date-sep::after {
  content: "";
  position: absolute;
  top: 50%;
  width: calc(50% - 70px);
  height: 1px;
  background: #dde0e8;
}

.tgc-date-sep::before {
  left: 0;
}
.tgc-date-sep::after {
  right: 0;
}

.tgc-unread-sep {
  text-align: center;
  font-size: 12px;
  color: #4a9eff;
  margin: 12px 0 6px;
  position: relative;
}
.tgc-unread-sep::before,
.tgc-unread-sep::after {
  content: "";
  position: absolute;
  top: 50%;
  width: calc(50% - 72px);
  height: 1px;
  background: #4a9eff66;
}
.tgc-unread-sep::before {
  left: 0;
}
.tgc-unread-sep::after {
  right: 0;
}

.tgc-msg-wrap {
  display: flex;
  margin: 2px 0;
}

.tgc-msg-in {
  justify-content: flex-start;
}

.tgc-sender-av,
.tgc-sender-av-ph {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  margin-right: 6px;
  align-self: flex-end;
  order: -1;
}

.tgc-sender-av {
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  user-select: none;
  overflow: hidden;
}

.tgc-sender-av-photo {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.tgc-msg-out {
  justify-content: flex-end;
}

.tgc-msg-bubble {
  max-width: 68%;
  min-width: 80px;
  padding: 7px 10px 5px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
}

.tgc-msg-in .tgc-msg-bubble {
  background: #fff;
  border: 1px solid #e8e9ed;
  border-bottom-left-radius: 4px;
  color: #1a1a2e;
}

.tgc-msg-out .tgc-msg-bubble {
  background: #4361ee;
  border-bottom-right-radius: 4px;
  color: #fff;
}

.tgc-msg-sender {
  font-size: 12px;
  font-weight: 600;
  color: #4361ee;
  margin-bottom: 2px;
}

.tgc-msg-out .tgc-msg-sender {
  color: rgba(255, 255, 255, 0.85);
}

.tgc-msg-text {
  white-space: pre-wrap;
}

.tgc-link {
  color: #4a9eff;
  text-decoration: underline;
  cursor: pointer;
  word-break: break-all;
}

.tgc-msg-doc {
  color: #999;
  font-style: italic;
  font-size: 13px;
}

.tgc-msg-photo {
  max-width: 260px;
  max-height: 300px;
  border-radius: 8px;
  display: block;
  margin-bottom: 4px;
}

.tgc-msg-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  margin-top: 3px;
}

.tgc-msg-time {
  font-size: 11px;
  color: #bbb;
}

.tgc-msg-out .tgc-msg-time {
  color: rgba(255, 255, 255, 0.65);
}

.tgc-msg-tick {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.65);
}

.tgc-msg-buttons {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tgc-btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tgc-btn-chip {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.35);
  color: inherit;
  transition:
    background 0.15s,
    opacity 0.15s;
}

.tgc-btn-chip:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.3);
}

.tgc-btn-chip:disabled {
  opacity: 0.55;
  cursor: default;
}

.tgc-btn-chip.tgc-btn-loading {
  opacity: 0.6;
  cursor: wait;
}

.tgc-msg-in .tgc-btn-chip {
  background: #eef1fb;
  border-color: #d0d4e8;
  color: #4361ee;
}

.tgc-msg-in .tgc-btn-chip:hover:not(:disabled) {
  background: #e0e4f7;
}

/* ── Message hover actions ──────────────────────────────────────────────────── */
.tgc-msg-wrap {
  position: relative;
  align-items: center;
}

.tgc-msg-actions {
  display: none;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
}

.tgc-msg-wrap:hover .tgc-msg-actions {
  display: flex;
}

.tgc-msg-in .tgc-msg-actions {
  order: 2;
  margin-left: 4px;
}

.tgc-msg-out .tgc-msg-actions {
  order: 0;
  margin-right: 4px;
}

.tgc-msg-action {
  background: #fff;
  border: 1px solid #e8e9ed;
  border-radius: 50%;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: #888;
  cursor: pointer;
  transition:
    background 0.1s,
    color 0.1s;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
}

.tgc-msg-action:hover {
  background: #f0f2f5;
  color: #4361ee;
}

/* ── Reply quote in bubble ──────────────────────────────────────────────────── */
.tgc-reply-quote {
  display: flex;
  gap: 6px;
  border-radius: 6px;
  padding: 4px 6px;
  margin-bottom: 4px;
  cursor: pointer;
  background: rgba(0, 0, 0, 0.05);
  max-width: 100%;
  overflow: hidden;
  transition: background 0.1s;
}

.tgc-reply-quote:hover {
  background: rgba(0, 0, 0, 0.09);
}

.tgc-reply-bar {
  width: 3px;
  border-radius: 2px;
  background: #4361ee;
  flex-shrink: 0;
}

.tgc-msg-out .tgc-reply-bar {
  background: rgba(255, 255, 255, 0.7);
}

.tgc-reply-content {
  min-width: 0;
}

.tgc-reply-name {
  font-size: 11px;
  font-weight: 600;
  color: #4361ee;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tgc-msg-out .tgc-reply-name {
  color: rgba(255, 255, 255, 0.85);
}

.tgc-reply-text {
  font-size: 12px;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tgc-msg-out .tgc-reply-text {
  color: rgba(255, 255, 255, 0.7);
}

/* ── Reactions ──────────────────────────────────────────────────────────────── */
.tgc-reactions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.tgc-reaction {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: #f0f2f5;
  border: 1px solid #e0e3ea;
  border-radius: 12px;
  padding: 2px 7px;
  font-size: 14px;
  cursor: pointer;
  transition:
    background 0.1s,
    border-color 0.1s;
  line-height: 1;
}

.tgc-reaction:hover {
  background: #e4e8f5;
  border-color: #c4cbdf;
}

.tgc-reaction-mine {
  background: #dce3ff;
  border-color: #4361ee;
}

.tgc-msg-out .tgc-reaction {
  background: rgba(255, 255, 255, 0.18);
  border-color: rgba(255, 255, 255, 0.35);
  color: #fff;
}

.tgc-msg-out .tgc-reaction-mine {
  background: rgba(255, 255, 255, 0.35);
}

.tgc-reaction-count {
  font-size: 11px;
  font-weight: 600;
}

/* ── Comment count button ───────────────────────────────────────────────────── */
.tgc-comment-btn {
  background: none;
  border: none;
  color: #999;
  font-size: 11px;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  gap: 3px;
  margin-right: auto;
  transition: color 0.1s;
}

.tgc-comment-btn:hover {
  color: #4361ee;
}

.tgc-msg-out .tgc-comment-btn {
  color: rgba(255, 255, 255, 0.65);
}

/* ── Highlight flash (scroll-to-reply) ──────────────────────────────────────── */
.tgc-msg-highlighted .tgc-msg-bubble {
  animation: tgc-highlight 1.5s ease;
}

@keyframes tgc-highlight {
  0%,
  15% {
    box-shadow: 0 0 0 3px rgba(67, 97, 238, 0.4);
  }
  100% {
    box-shadow: none;
  }
}

/* ── Emoji picker ───────────────────────────────────────────────────────────── */
.tgc-emoji-picker {
  position: fixed;
  display: flex;
  gap: 2px;
  background: #fff;
  border: 1px solid #e8e9ed;
  border-radius: 28px;
  padding: 6px 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  z-index: 61;
}

.tgc-emoji-btn {
  font-size: 22px;
  background: none;
  border: none;
  cursor: pointer;
  padding: 3px 5px;
  border-radius: 8px;
  line-height: 1;
  transition:
    background 0.1s,
    transform 0.1s;
}

.tgc-emoji-btn:hover {
  background: #f0f2f5;
  transform: scale(1.25);
}

/* ── Bot command suggestions ────────────────────────────────────────────────── */
.tgc-cmd-suggestions {
  border-top: 1px solid #e8e9ed;
  max-height: 220px;
  overflow-y: auto;
  background: #fff;
  flex-shrink: 0;
  scrollbar-width: thin;
}

.tgc-cmd-item {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 9px 16px;
  cursor: pointer;
  transition: background 0.1s;
}

.tgc-cmd-item:hover,
.tgc-cmd-selected {
  background: #f0f3ff;
}

.tgc-cmd-name {
  font-size: 14px;
  font-weight: 600;
  color: #4361ee;
  flex-shrink: 0;
}

.tgc-cmd-desc {
  font-size: 13px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

/* Slash button in compose row */
.tgc-slash-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: #f5f6fa;
  border: 1px solid #dde0e8;
  color: #4361ee;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background 0.15s,
    border-color 0.15s;
  line-height: 1;
  font-family: monospace;
}

.tgc-slash-btn:hover,
.tgc-slash-btn.active {
  background: #eef1fb;
  border-color: #4361ee;
}

/* ── Reply compose strip ────────────────────────────────────────────────────── */
.tgc-reply-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: #f8f9fb;
  border-bottom: 1px solid #e8e9ed;
  border-radius: 0;
}

.tgc-reply-strip-icon {
  color: #4361ee;
  font-size: 13px;
  flex-shrink: 0;
}

.tgc-reply-strip-body {
  flex: 1;
  min-width: 0;
}

.tgc-reply-strip-name {
  font-size: 12px;
  font-weight: 600;
  color: #4361ee;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tgc-reply-strip-text {
  font-size: 12px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Compose ────────────────────────────────────────────────────────────────── */
.tgc-join-pending {
  color: #555;
  font-size: 13px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex: 1;
}

.tgc-join-pending i {
  color: #f4a261;
  margin-top: 2px;
  flex-shrink: 0;
}

.tgc-join-check-btn {
  background: none;
  border: 1px solid #4361ee;
  color: #4361ee;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}

.tgc-join-check-btn:hover {
  background: #eef0fd;
}

/* ── Mini App overlay ───────────────────────────────────────────────────────── */
.tgc-webview-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  background: #fff;
}

.tgc-webview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #e8e9ed;
  background: #fff;
  flex-shrink: 0;
}

.tgc-webview-title {
  font-size: 14px;
  font-weight: 600;
  color: #1a1a2e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tgc-webview-frame {
  flex: 1;
  border: none;
  width: 100%;
}

.tgc-join-bar {
  border-top: 1px solid #e8e9ed;
  flex-shrink: 0;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px 16px;
}
.tgc-join-btn {
  background: #4361ee;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 10px 32px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  justify-content: center;
}
.tgc-join-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.tgc-join-btn:not(:disabled):hover {
  background: #3251d3;
}
.tgc-spinner-sm {
  width: 14px;
  height: 14px;
  border-width: 2px;
}

.tgc-compose {
  display: flex;
  flex-direction: column;
  border-top: 1px solid #e8e9ed;
  flex-shrink: 0;
  background: #fff;
}

.tgc-compose-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 16px;
}

.tgc-input {
  flex: 1;
  background: #f5f6fa;
  border: 1px solid #dde0e8;
  border-radius: 20px;
  padding: 8px 14px;
  font-size: 14px;
  color: #1a1a2e;
  resize: none;
  outline: none;
  min-height: 38px;
  max-height: 120px;
  overflow-y: auto;
  line-height: 1.4;
  transition: border-color 0.15s;
  font-family: inherit;
}

.tgc-input:focus {
  border-color: #4361ee;
  background: #fff;
}

.tgc-send-btn {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: #4361ee;
  border: none;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    opacity 0.15s,
    transform 0.1s;
}

.tgc-send-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.tgc-send-btn:not(:disabled):hover {
  opacity: 0.85;
}

.tgc-send-btn:not(:disabled):active {
  transform: scale(0.93);
}

/* ── Empty states ───────────────────────────────────────────────────────────── */
.tgc-empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #bbb;
  gap: 12px;
  font-size: 14px;
  background: #f5f7fb;
}

.tgc-empty-list,
.tgc-empty-chat {
  text-align: center;
  color: #aaa;
  font-size: 13px;
  padding: 24px 16px;
}

.tgc-list-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: #e63946;
  font-size: 13px;
  padding: 20px 16px;
  text-align: center;
  line-height: 1.5;
}

.tgc-list-error-icon {
  font-size: 24px;
  opacity: 0.8;
}

.tgc-reconnect-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 7px 16px;
  border: none;
  border-radius: 8px;
  background: #4361ee;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.tgc-reconnect-btn:hover:not(:disabled) {
  background: #3451d1;
}

.tgc-reconnect-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.tgc-spinner-sm {
  width: 12px;
  height: 12px;
  border-width: 2px;
}

.tgc-spinner-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}

.tgc-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid #e0e0e8;
  border-top-color: #4361ee;
  border-radius: 50%;
  animation: tgc-spin 0.7s linear infinite;
}

@keyframes tgc-spin {
  to {
    transform: rotate(360deg);
  }
}

.tgc-load-more {
  display: flex;
  justify-content: center;
  padding: 8px;
}

.tgc-load-more-btn {
  background: none;
  border: 1px solid #dde0e8;
  color: #4361ee;
  border-radius: 16px;
  padding: 4px 16px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.tgc-load-more-btn:hover {
  background: #f0f2f5;
}

/* ── Contacts overlay ───────────────────────────────────────────────────────── */
.tgc-contacts-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 10;
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  border-radius: 12px;
  overflow: hidden;
}

.tgc-contacts-panel {
  width: 320px;
  background: #fff;
  border-left: 1px solid #e8e9ed;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tgc-contacts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #e8e9ed;
  font-size: 15px;
  font-weight: 600;
  flex-shrink: 0;
  color: #1a1a2e;
}

.tgc-contacts-search {
  position: relative;
  padding: 8px 12px;
  flex-shrink: 0;
}

.tgc-contacts-search .tgc-search-icon {
  top: 50%;
}

.tgc-contacts-search .tgc-search-input {
  padding-left: 30px;
}

.tgc-contact-list {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
}

.tgc-contact-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  cursor: pointer;
  transition: background 0.1s;
}

.tgc-contact-item:hover {
  background: #f0f2f5;
}

.tgc-contact-info {
  min-width: 0;
}

.tgc-contact-name {
  font-size: 14px;
  font-weight: 500;
  color: #1a1a2e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tgc-contact-sub {
  font-size: 12px;
  color: #999;
}

.tgc-add-contact {
  border-top: 1px solid #e8e9ed;
  padding: 12px 14px;
  flex-shrink: 0;
}

.tgc-add-contact-title {
  font-size: 12px;
  font-weight: 600;
  color: #888;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.tgc-add-contact-fields {
  display: flex;
  gap: 6px;
}

.tgc-add-contact-fields .form-input {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  padding: 5px 8px;
}

.tgc-add-contact-fields .btn {
  flex-shrink: 0;
  padding: 5px 12px;
  font-size: 13px;
}

/* ── Avatar photo overlay ───────────────────────────────────────────────────── */
.tgc-avatar {
  position: relative;
  overflow: hidden;
}

.tgc-avatar-photo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

/* ── Clickable header elements ──────────────────────────────────────────────── */
.tgc-clickable {
  cursor: pointer;
}

.tgc-chat-title-wrap.tgc-clickable:hover .tgc-chat-name {
  color: #4361ee;
}

/* ── Profile panel ──────────────────────────────────────────────────────────── */
.tgc-profile-panel {
  width: 300px;
  flex-shrink: 0;
  background: #fff;
  border-left: 1px solid #e8e9ed;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  animation: tgc-slide-right 0.18s ease;
}

@keyframes tgc-slide-right {
  from {
    transform: translateX(100%);
  }
  to {
    transform: translateX(0);
  }
}

.tgc-profile-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid #e8e9ed;
  flex-shrink: 0;
}

.tgc-profile-title {
  font-size: 15px;
  font-weight: 600;
  color: #1a1a2e;
}

.tgc-profile-body {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
}

.tgc-profile-avatar-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 16px 16px;
  border-bottom: 1px solid #f0f2f5;
}

.tgc-profile-avatar {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
  margin-bottom: 12px;
}

.tgc-profile-name {
  font-size: 17px;
  font-weight: 600;
  color: #1a1a2e;
  text-align: center;
  word-break: break-word;
}

.tgc-profile-type-badge {
  margin-top: 4px;
  font-size: 12px;
  color: #888;
  text-transform: capitalize;
}

.tgc-profile-rows {
  padding: 8px 0;
}

.tgc-profile-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  cursor: pointer;
  transition: background 0.1s;
  min-height: 52px;
}

.tgc-profile-row:hover {
  background: #f5f6fa;
}

.tgc-profile-row-nocopy {
  cursor: default;
}

.tgc-profile-row-nocopy:hover {
  background: none;
}

.tgc-profile-row-icon {
  color: #4361ee;
  font-size: 16px;
  flex-shrink: 0;
  width: 18px;
  text-align: center;
}

.tgc-profile-row-body {
  flex: 1;
  min-width: 0;
}

.tgc-profile-row-label {
  font-size: 11px;
  color: #999;
  margin-bottom: 1px;
}

.tgc-profile-row-value {
  font-size: 14px;
  color: #1a1a2e;
  word-break: break-word;
}

.tgc-bio-text {
  white-space: pre-wrap;
  font-size: 13px;
  color: #444;
  line-height: 1.5;
}

.tgc-copy-icon {
  color: #bbb;
  font-size: 13px;
  flex-shrink: 0;
  transition: color 0.1s;
}

.tgc-profile-row:hover .tgc-copy-icon {
  color: #4361ee;
}

/* ── Copy toast ─────────────────────────────────────────────────────────────── */
.tgc-copy-toast {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(26, 26, 46, 0.85);
  color: #fff;
  font-size: 13px;
  padding: 6px 16px;
  border-radius: 20px;
  pointer-events: none;
  z-index: 100;
  white-space: nowrap;
  animation: tgc-fade-in 0.15s ease;
}

@keyframes tgc-fade-in {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

/* ── Context menu ───────────────────────────────────────────────────────────── */
.tgc-ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
}

.tgc-ctx-menu {
  position: fixed;
  background: #fff;
  border: 1px solid #e8e9ed;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  z-index: 51;
  min-width: 180px;
  padding: 4px 0;
  animation: tgc-fade-in 0.1s ease;
}

.tgc-ctx-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  background: none;
  border: none;
  padding: 9px 14px;
  font-size: 14px;
  color: #1a1a2e;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.tgc-ctx-item:hover {
  background: #f0f2f5;
}

.tgc-ctx-item i {
  width: 16px;
  text-align: center;
  color: #666;
}

.tgc-ctx-divider {
  height: 1px;
  background: #e8e9ed;
  margin: 4px 0;
}

/* ── Back button ──────────────────────────────────────────────────────────────
   Visibility is controlled by v-show (JS), not CSS alone, so it is reliable
   regardless of screen width or media-query quirks.
────────────────────────────────────────────────────────────────────────────── */
.tgc-back-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: #4361ee;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 15px;
  font-weight: 500;
  flex-shrink: 0;
  transition:
    background 0.15s,
    color 0.15s;
}

.tgc-back-btn:hover {
  background: #eef0fb;
}

/* "Back" text label -- always shown alongside the arrow */
.tgc-back-label {
  font-size: 13px;
}

/* ── Close button in chat header (always visible) ────────────────────────────
   On mobile the main header is hidden when a chat is open, so this is the
   only way to exit. On desktop it is a convenient shortcut.
────────────────────────────────────────────────────────────────────────────── */
.tgc-chat-close-btn {
  flex-shrink: 0;
}

/* ── Responsive ─────────────────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .tgc-backdrop {
    padding: 0;
    align-items: flex-end;
  }

  .tgc-popup {
    height: 100dvh;
    height: 100vh; /* fallback for browsers without dvh */
    max-height: none;
    border-radius: 0;
    width: 100%;
  }

  /* Hide outer header when a chat is open -- chat header takes over */
  .tgc-popup.mobile-chat-open .tgc-header {
    display: none;
  }

  /* Single-panel: sidebar fills the body */
  .tgc-sidebar {
    width: 100%;
    flex-shrink: 0;
    border-right: none;
  }

  /* Chat panel hidden until a chat is opened */
  .tgc-chat {
    display: none;
    width: 100%;
  }

  /* When a chat is open: hide sidebar, show chat */
  .tgc-body.chat-open .tgc-sidebar {
    display: none;
  }

  .tgc-body.chat-open .tgc-chat {
    display: flex;
  }

  /* Empty state stays hidden when sidebar is showing */
  .tgc-empty-state {
    display: none;
  }

  /* Contacts panel full-width on mobile */
  .tgc-contacts-panel {
    width: 100%;
    border-left: none;
  }

  /* Profile panel overlays the chat on mobile */
  .tgc-profile-panel {
    position: absolute;
    inset: 0;
    width: 100%;
    z-index: 20;
    border-left: none;
  }

  /* Message bubbles on narrow screens */
  .tgc-msg-bubble {
    max-width: 85%;
  }

  .tgc-messages {
    padding: 12px;
    -webkit-overflow-scrolling: touch;
  }

  /* Tap-to-show message actions on mobile (no hover available) */
  .tgc-msg-wrap.tgc-msg-active .tgc-msg-actions {
    display: flex;
  }

  /* Larger touch targets for message action buttons */
  .tgc-msg-action {
    width: 34px;
    height: 34px;
    font-size: 13px;
  }

  /* Header: hide logo only -- keep "Messenger" title so users have context */
  .tgc-logo {
    display: none;
  }

  .tgc-header-left {
    flex: 1;
    min-width: 0;
    gap: 6px;
  }

  .tgc-account-select {
    flex: 1;
    max-width: none;
    min-width: 0;
    font-size: 14px;
    padding: 5px 8px;
  }

  /* Minimum touch target sizes (Apple HIG recommends 44px) */
  .tgc-icon-btn,
  .tgc-back-btn {
    min-width: 44px;
    min-height: 44px;
    padding: 8px;
  }

  /* Slightly larger send button */
  .tgc-send-btn {
    width: 44px;
    height: 44px;
  }

  /* Bigger folder tab touch targets */
  .tgc-folder-tab {
    padding: 6px 14px;
    font-size: 13px;
  }

  /* Safe-area bottom padding for compose box (iPhone home indicator) */
  .tgc-compose-row {
    padding-bottom: max(10px, env(safe-area-inset-bottom));
  }

  .tgc-dialog-list {
    -webkit-overflow-scrolling: touch;
  }
}

/* ── Thread panel ───────────────────────────────────────────────────────────── */
.tgc-thread-panel {
  width: 300px;
  flex-shrink: 0;
  background: #fff;
  border-left: 1px solid #e8e9ed;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: tgc-slide-right 0.18s ease;
}

.tgc-thread-count {
  font-size: 12px;
  font-weight: 600;
  background: #4361ee;
  color: #fff;
  border-radius: 10px;
  padding: 1px 6px;
  margin-left: 6px;
  vertical-align: middle;
}

.tgc-thread-root {
  border-bottom: 1px solid #f0f2f5;
  padding: 10px 16px;
  background: #f8f9fb;
  flex-shrink: 0;
}

.tgc-thread-root-text {
  font-size: 13px;
  color: #555;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 60px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.tgc-thread-messages {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: #f5f7fb;
}

.tgc-thread-msg {
  max-width: 90%;
}

.tgc-thread-msg-in {
  align-self: flex-start;
}

.tgc-thread-msg-out {
  align-self: flex-end;
}

.tgc-thread-msg-name {
  font-size: 11px;
  font-weight: 600;
  color: #4361ee;
  margin-bottom: 2px;
}

.tgc-thread-msg-text {
  font-size: 13px;
  line-height: 1.4;
  word-break: break-word;
  padding: 6px 10px;
  border-radius: 10px;
  white-space: pre-wrap;
}

.tgc-thread-msg-in .tgc-thread-msg-text {
  background: #fff;
  border: 1px solid #e8e9ed;
  border-bottom-left-radius: 3px;
  color: #1a1a2e;
}

.tgc-thread-msg-out .tgc-thread-msg-text {
  background: #4361ee;
  color: #fff;
  border-bottom-right-radius: 3px;
}

.tgc-thread-msg-time {
  font-size: 10px;
  color: #bbb;
  margin-top: 2px;
  text-align: right;
}

.tgc-thread-msg-in .tgc-thread-msg-time {
  text-align: left;
}

.tgc-thread-compose {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid #e8e9ed;
  flex-shrink: 0;
  background: #fff;
}

@media (max-width: 640px) {
  .tgc-thread-panel {
    position: absolute;
    inset: 0;
    width: 100%;
    z-index: 20;
    border-left: none;
  }
}

/* ── Invite join confirmation overlay ─────────────────────────────────────── */

.tgc-invite-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.tgc-invite-card {
  background: #fff;
  border-radius: 16px;
  padding: 32px 24px 24px;
  max-width: 320px;
  width: 100%;
  text-align: center;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.tgc-invite-icon {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #e8eeff;
  color: #4361ee;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  margin: 0 auto 14px;
}

.tgc-invite-title {
  font-size: 18px;
  font-weight: 700;
  color: #111;
  margin-bottom: 6px;
  word-break: break-word;
}

.tgc-invite-meta {
  font-size: 13px;
  color: #666;
  margin-bottom: 24px;
}

.tgc-invite-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}

.tgc-invite-cancel {
  flex: 1;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 8px;
  background: #fff;
  color: #444;
  font-size: 14px;
  cursor: pointer;
}

.tgc-invite-cancel:hover {
  background: #f5f5f5;
}

.tgc-invite-join {
  flex: 1;
  padding: 10px;
  border: none;
  border-radius: 8px;
  background: #4361ee;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.tgc-invite-join:hover:not(:disabled) {
  background: #3451d1;
}

.tgc-invite-join:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}
</style>
