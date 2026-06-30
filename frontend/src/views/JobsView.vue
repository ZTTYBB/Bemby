<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t('jobs.title') }}</h2>
      <button class="btn btn-primary" @click="openAdd"><i class="fa-solid fa-plus"></i> {{ t('jobs.addBtn') }}</button>
    </div>

    <!-- Scheduler status -->
    <div v-if="scheduleStatus.length" class="card" style="margin-bottom:16px;padding:14px 18px">
      <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:8px">
        {{ t('jobs.nextRuns') }}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px">
        <div v-for="s in sortedScheduleStatus" :key="s.jobId" style="font-size:13px">
          <strong>{{ s.jobName }}</strong>: {{ fmtDateTime(s.nextRun) }}
        </div>
      </div>
    </div>

    <div class="card">
      <!-- Filters -->
      <div style="padding:12px 16px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button
          v-for="opt in filterOptions" :key="opt.value"
          class="btn btn-sm"
          :class="filterType === opt.value ? 'btn-primary' : 'btn-ghost'"
          @click="filterType = opt.value"
        >{{ opt.label }}</button>
        <select v-if="accounts.length > 1" v-model="filterAccountId" class="form-select" style="width:160px;height:30px;font-size:13px;padding:0 8px">
          <option value="">{{ t('jobs.allAccounts') }}</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
        <select v-if="botUrlTplOptions.length > 1" v-model="filterBotUrlTpl" class="form-select" style="width:180px;height:30px;font-size:13px;padding:0 8px">
          <option value="">{{ t('jobs.allBotUrlTpl') }}</option>
          <option v-for="opt in botUrlTplOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <button v-if="sortedJobs.length" class="btn btn-sm btn-secondary" style="margin-left:auto" @click="toggleAllJobs">
          {{ allJobsSelected ? t('common.deselectAll') : t('common.selectAll') }}
        </button>
      </div>
      <!-- Bulk action bar -->
      <div v-if="selectedJobIds.length" class="bulk-bar">
        <span class="bulk-count">{{ t('jobs.selectedCount').replace('{n}', String(selectedJobIds.length)) }}</span>
        <button class="btn btn-sm btn-secondary" @click="bulkEnableJobs"><i class="fa-solid fa-circle-check"></i> {{ t('jobs.bulkEnable').replace('{n}', String(selectedJobIds.length)) }}</button>
        <button class="btn btn-sm btn-secondary" @click="confirmBulkDisableJobs = true"><i class="fa-solid fa-ban"></i> {{ t('jobs.bulkDisable').replace('{n}', String(selectedJobIds.length)) }}</button>
        <button class="btn btn-sm btn-danger" @click="confirmBulkDeleteJobs = true"><i class="fa-solid fa-trash"></i> {{ t('jobs.bulkDelete').replace('{n}', String(selectedJobIds.length)) }}</button>
        <button class="btn btn-sm btn-ghost" style="margin-left:auto" @click="selectedJobIds = []"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="th-sort" :class="sortKey === 'name' ? 'sort-active' : ''" @click="setSort('name')">{{ t('common.name') }} <span class="sort-icon">{{ sortIcon('name') }}</span></th>
              <th class="th-sort" :class="sortKey === 'account' ? 'sort-active' : ''" @click="setSort('account')">{{ t('jobs.colAccount') }} <span class="sort-icon">{{ sortIcon('account') }}</span></th>
              <th class="th-sort" :class="sortKey === 'type' ? 'sort-active' : ''" @click="setSort('type')">{{ t('jobs.colType') }} <span class="sort-icon">{{ sortIcon('type') }}</span></th>
              <th class="th-sort col-hide-mobile" :class="sortKey === 'botUrl' ? 'sort-active' : ''" @click="setSort('botUrl')">{{ t('jobs.colBotUrlTpl') }} <span class="sort-icon">{{ sortIcon('botUrl') }}</span></th>
              <th class="th-sort col-hide-mobile" :class="sortKey === 'window' ? 'sort-active' : ''" @click="setSort('window')">{{ t('jobs.colWindow') }} <span class="sort-icon">{{ sortIcon('window') }}</span></th>
              <th class="th-sort" :class="sortKey === 'enabled' ? 'sort-active' : ''" @click="setSort('enabled')">{{ t('jobs.colEnabled') }} <span class="sort-icon">{{ sortIcon('enabled') }}</span></th>
              <th>{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!sortedJobs.length">
              <td colspan="7" class="empty">{{ t('jobs.noJobs') }}</td>
            </tr>
            <tr
              v-for="j in sortedJobs" :key="j.id"
              style="cursor:pointer"
              :class="selectedJobIds.includes(j.id) ? 'row-selected' : ''"
              @click="toggleJobSelect(j.id)"
            >
              <td>{{ j.name }}</td>
              <td>{{ j.accountName ?? j.accountId }}</td>
              <td><span :class="jobTypeBadge(j.jobType)">{{ t(`logs.jobType.${j.jobType}`) }}</span></td>
              <td class="col-hide-mobile">
                <template v-if="j.templateId">
                  <span class="badge badge-tpl" style="margin-left:0;margin-right:4px">T</span>{{ templates.find(t => t.id === j.templateId)?.name ?? '' }}
                </template>
                <template v-else>{{ j.jobType === 'embywatch' ? j.botUsername : '@' + j.botUsername }}</template>
              </td>
              <td class="col-hide-mobile">{{ fmtWindow(j.scheduleWindowStart, j.scheduleWindowEnd) }}</td>
              <td>
                <span
                  :class="j.enabled ? 'badge badge-green' : 'badge badge-grey'"
                  style="cursor:pointer;user-select:none"
                  @click.stop="toggleEnabled(j)"
                >
                  {{ j.enabled ? t('common.yes') : t('common.no') }}
                </span>
              </td>
              <td @click.stop>
                <!-- desktop: icon buttons -->
                <div class="actions hide-mobile">
                  <button class="btn btn-sm btn-success btn-icon" :disabled="running.has(j.id)" :title="t('common.run')" @click="runNow(j.id)">
                    <i class="fa-solid fa-play"></i>
                  </button>
                  <button class="btn btn-sm btn-ghost btn-icon" :title="t('common.edit')" @click="openEdit(j)"><i class="fa-solid fa-pen"></i></button>
                  <button class="btn btn-sm btn-ghost btn-icon" :title="t('common.duplicate')" @click="openDuplicate(j)"><i class="fa-solid fa-copy"></i></button>
                  <button class="btn btn-sm btn-danger btn-icon" :title="t('common.delete')" @click="remove(j.id)"><i class="fa-solid fa-trash"></i></button>
                </div>
                <!-- mobile: single button opens action sheet -->
                <button class="btn btn-sm btn-ghost btn-icon show-mobile" @click="actionMenuJob = j">
                  <i class="fa-solid fa-ellipsis-vertical"></i>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Add / Edit modal -->
    <div v-if="showForm" class="modal-backdrop">
      <div class="modal" style="width:560px">
        <h3 class="modal-title">{{ t(editTarget ? 'jobs.editTitle' : 'jobs.addTitle') }}</h3>
        <div class="modal-body">
        <div v-if="formError" class="error-msg">{{ formError }}</div>

        <!-- Template selector + Enabled inline -->
        <div v-if="templates.length" style="display:flex;gap:12px;align-items:flex-end;margin-bottom:14px">
          <div style="flex:1">
            <label class="form-label">{{ t('templates.labelTemplate') }}</label>
            <select v-model="form.templateId" class="form-select" @change="onTemplateChange">
              <option :value="null">{{ t('templates.noTemplate') }}</option>
              <option v-for="tpl in templates.filter(t => t.enabled || t.id === form.templateId)" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
            </select>
          </div>
          <div style="padding-bottom:9px;white-space:nowrap">
            <label class="form-check">
              <input v-model="form.enabled" type="checkbox" />
              <span>{{ t('jobs.labelEnabled') }}</span>
            </label>
          </div>
        </div>

        <!-- Enabled standalone (no templates configured) -->
        <div v-else style="margin-bottom:14px">
          <label class="form-check">
            <input v-model="form.enabled" type="checkbox" />
            <span>{{ t('jobs.labelEnabled') }}</span>
          </label>
        </div>

        <!-- Template summary -->
        <div v-if="form.templateId && linkedTemplate" class="template-summary-card">
          <div class="template-summary-row">
            <span :class="jobTypeBadge(linkedTemplate.jobType)">{{ t(`logs.jobType.${linkedTemplate.jobType}`) }}</span>
            <span class="template-summary-detail">{{ linkedTemplate.jobType === 'embywatch' ? linkedTemplate.botUsername : '@' + linkedTemplate.botUsername }}</span>
          </div>
        </div>

        <!-- Name + Type (no template) | Name + Account (template, checkin/custom) -->
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelName') }} <span style="color:#e63946">*</span></label>
            <input v-model.trim="form.name" class="form-input" placeholder="Xxemby" />
          </div>
          <div v-if="!form.templateId" class="form-group">
            <label class="form-label">{{ t('jobs.labelType') }}</label>
            <select v-model="form.jobType" class="form-select" @change="onJobTypeChange">
              <option value="checkin">Check-in (签到)</option>
              <option value="embywatch">Emby Watch (观看)</option>
              <option value="custom">Custom (自定义)</option>
            </select>
          </div>
          <div v-if="form.templateId && (form.jobType === 'checkin' || form.jobType === 'custom')" class="form-group">
            <label class="form-label">{{ t('jobs.labelAccount') }} <span style="color:#e63946">*</span></label>
            <select v-model="form.accountId" class="form-select">
              <option :value="null" disabled>{{ t('jobs.selectAccount') }}</option>
              <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
            </select>
          </div>
        </div>

        <!-- Check-in: Account + Bot (no template only — when template, account is in the row above) -->
        <div v-if="form.jobType === 'checkin' && !form.templateId" class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelAccount') }} <span style="color:#e63946">*</span></label>
            <select v-model="form.accountId" class="form-select">
              <option :value="null" disabled>{{ t('jobs.selectAccount') }}</option>
              <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelBot') }} <span style="color:#e63946">*</span></label>
            <input v-model.trim="form.botUsername" class="form-input" placeholder="SomeBotUsername" />
          </div>
        </div>

        <!-- Emby Watch: Server URL (hidden when template controls it) -->
        <div v-if="form.jobType === 'embywatch' && !form.templateId" class="form-group">
          <label class="form-label">{{ t('jobs.labelServerUrl') }} <span style="color:#e63946">*</span></label>
          <div style="display:flex;align-items:center;gap:6px">
            <select v-model="embyServer.protocol" class="form-select" style="width:88px;flex-shrink:0">
              <option value="https">https</option>
              <option value="http">http</option>
            </select>
            <span style="color:#aaa;font-size:13px;flex-shrink:0">://</span>
            <input v-model.trim="embyServer.host" class="form-input" placeholder="emby.xxxx.com" @paste="handleEmbyHostPaste" />
            <span style="color:#aaa;font-size:13px;flex-shrink:0">:</span>
            <input v-model.number="embyServer.port" class="form-input" type="number" min="1" max="65535" style="width:72px;flex-shrink:0" placeholder="443" />
          </div>
        </div>

        <!-- Emby credentials (always job-specific, shown even for template-linked jobs) -->
        <template v-if="form.jobType === 'embywatch'">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelEmbyUser') }} <span style="color:#e63946">*</span></label>
              <input v-model.trim="embyCfg.username" class="form-input" placeholder="Username" autocomplete="off" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelEmbyPass') }} <span style="color:#e63946">*</span></label>
              <input v-model="embyCfg.password" class="form-input" type="password" placeholder="Password" autocomplete="new-password" />
            </div>
          </div>
        </template>

        <!-- embywatch-specific fields (hidden when template controls them) -->
        <template v-if="form.jobType === 'embywatch' && !form.templateId">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">
                {{ t('jobs.labelPlayDuration') }}
                <span style="color:#aaa;font-weight:400"> — {{ t('common.blankForDefault') }}</span>
              </label>
              <input v-model.number="embyCfg.playDuration" class="form-input" type="number" min="30" placeholder="300" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelUserAgent') }}</label>
            <select v-model="embyUaDropdown" class="form-select" @change="onUaDropdownChange">
              <option value="">{{ t('jobs.uaDefault') }}</option>
              <option v-for="p in uaPresets" :key="p.name" :value="p.name">{{ p.name }}</option>
              <option value="__custom__">{{ t('jobs.uaCustom') }}</option>
            </select>
            <textarea
              v-if="embyUaDropdown === '__custom__'"
              v-model.trim="embyCfg.userAgent"
              class="form-input"
              rows="2"
              style="margin-top:6px;resize:vertical"
              placeholder="Mozilla/5.0 ..."
            />
          </div>
          <div class="emby-rules-hint">{{ t('jobs.playbackRulesHint') }}</div>
          <div class="form-group" style="margin-top:4px">
            <label class="form-check">
              <input v-model="embyCfg.markWatched" type="checkbox" />
              <span>{{ t('jobs.labelMarkWatched') }}</span>
            </label>
            <div style="font-size:11px;color:#aaa;margin-top:4px;padding-left:24px">{{ t('jobs.markWatchedHint') }}</div>
          </div>
        </template>
        <!-- embywatch optional account (always shown, job-specific) -->
        <div v-if="form.jobType === 'embywatch' && accounts.length > 0" class="form-group" style="margin-top:8px">
          <label class="form-label">
            {{ t('jobs.labelAccount') }}
            <span style="color:#aaa;font-weight:400"> — {{ t('jobs.accountOptionalHint') }}</span>
          </label>
          <select v-model="form.accountId" class="form-select">
            <option :value="null">{{ t('jobs.noAccount') }}</option>
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
        </div>

        <!-- Custom: Account + Bot (no template — when template, account is in the Name row above) -->
        <template v-if="form.jobType === 'custom'">
          <div v-if="!form.templateId" class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelAccount') }} <span style="color:#e63946">*</span></label>
              <select v-model="form.accountId" class="form-select">
                <option :value="null" disabled>{{ t('jobs.selectAccount') }}</option>
                <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.custom.labelTarget') }} <span style="color:#e63946">*</span></label>
              <input v-model.trim="form.botUsername" class="form-input" placeholder="BotUsername" />
            </div>
          </div>

          <div v-if="!form.templateId" class="form-group">
            <label class="form-label">{{ t('jobs.custom.labelJobMaxRetries') }}</label>
            <input v-model.number="customJobMaxRetries" class="form-input" type="number" min="1" max="20" style="max-width:120px" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.jobMaxRetriesHint') }}</div>
          </div>

          <!-- Action chain builder (hidden when template controls it) -->
          <div v-if="!form.templateId" class="form-group">
            <label class="form-label">{{ t('jobs.custom.actions') }}</label>

            <div v-if="customActions.length === 0" style="font-size:13px;color:#aaa;padding:10px 0">
              {{ t('jobs.custom.noActions') }}
            </div>

            <div v-for="(action, i) in customActions" :key="i" class="custom-action-card">
              <!-- Row: step number + type selector + move/delete buttons -->
              <div class="custom-action-header">
                <span class="custom-action-num">{{ i + 1 }}</span>
                <select v-model="action.type" class="form-select custom-action-type-select">
                  <option value="send_command">{{ t('jobs.custom.actionSendCommand') }}</option>
                  <option value="wait_reply">{{ t('jobs.custom.actionWaitReply') }}</option>
                  <option value="delay">{{ t('jobs.custom.actionDelay') }}</option>
                  <option value="click_button">{{ t('jobs.custom.actionClickButton') }}</option>
                  <option value="enter_captcha" :disabled="aiKeyMissing">{{ t('jobs.custom.actionEnterCaptcha') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                </select>
                <button type="button" class="btn btn-ghost btn-sm btn-icon" :disabled="i === 0" @click="moveUp(i)"><i class="fa-solid fa-arrow-up"></i></button>
                <button type="button" class="btn btn-ghost btn-sm btn-icon" :disabled="i === customActions.length - 1" @click="moveDown(i)"><i class="fa-solid fa-arrow-down"></i></button>
                <button type="button" class="btn btn-danger btn-sm btn-icon" @click="removeAction(i)"><i class="fa-solid fa-xmark"></i></button>
              </div>

              <!-- send_command -->
              <div v-if="action.type === 'send_command'" class="custom-action-params">
                <div class="form-row" style="margin-bottom:0">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelContent') }}</label>
                    <select v-model="action.contentDropdown" class="form-select">
                      <option value="/start">/start</option>
                      <option value="/checkin">/checkin</option>
                      <option value="{aiInput}" :disabled="aiKeyMissing">{{ t('jobs.aiInputOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                      <option value="custom">{{ t('common.custom') }}...</option>
                    </select>
                    <input v-if="action.contentDropdown === 'custom'" v-model="action.contentCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
                    <template v-if="action.contentDropdown === '{aiInput}'">
                      <input v-model.trim="action.contentAiInputLength" class="form-input" style="margin-top:6px" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
                      <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
                      <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                    </template>
                    <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.contentHint') }}</div>
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
              </div>

              <!-- wait_reply -->
              <div v-if="action.type === 'wait_reply'" class="custom-action-params">
                <div class="form-row" style="margin-bottom:0">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                    <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                  <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                  <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                </div>
              </div>

              <!-- delay -->
              <div v-if="action.type === 'delay'" class="custom-action-params">
                <label class="form-label">{{ t('jobs.custom.labelWaitMs') }}</label>
                <input v-model.number="action.waitMs" class="form-input" type="number" min="100" step="500" />
              </div>

              <!-- click_button -->
              <div v-if="action.type === 'click_button'" class="custom-action-params">
                <div class="form-row" style="margin-bottom:0">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelButton') }}</label>
                    <select v-model="action.buttonDropdown" class="form-select">
                      <option value="签到">签到</option>
                      <option value="{aiBtn}" :disabled="aiKeyMissing">{{ t('jobs.aiBtnOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                      <option value="{anyBtn}">{{ t('jobs.anyBtnOption') }}</option>
                      <option value="custom">{{ t('common.custom') }}...</option>
                    </select>
                    <input v-if="action.buttonDropdown === 'custom'" v-model="action.buttonCustom" class="form-input" style="margin-top:6px" placeholder="Custom button text" />
                    <template v-if="action.buttonDropdown === '{aiBtn}'">
                      <input v-model.trim="action.buttonAiHint" class="form-input" style="margin-top:6px" :placeholder="t('jobs.aiHintPlaceholder')" />
                      <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
                      <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
                    </template>
                    <div v-else style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.buttonHint') }}</div>
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                  <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelSuccessContains') }}</label>
                  <input v-model.trim="action.successContains" class="form-input" :placeholder="t('jobs.custom.successContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.successContainsHint') }}</div>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">{{ t('jobs.custom.labelFailContains') }}</label>
                  <input v-model.trim="action.failContains" class="form-input" :placeholder="t('jobs.custom.failContainsPlaceholder')" />
                  <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.custom.failContainsHint') }}</div>
                </div>
              </div>

              <!-- enter_captcha -->
              <div v-if="action.type === 'enter_captcha'" class="custom-action-params">
                <div class="form-row" style="margin-bottom:0">
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxWait') }}</label>
                    <input v-model.number="action.maxWaitMs" class="form-input" type="number" min="1000" step="1000" />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelCaptchaLength') }}</label>
                    <input v-model.trim="action.captchaLength" class="form-input" type="number" min="1" max="20" :placeholder="t('jobs.aiInputLengthPlaceholder')" />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('jobs.custom.labelMaxRetries') }}</label>
                    <input v-model.number="action.maxRetries" class="form-input" type="number" min="0" max="10" />
                  </div>
                </div>
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiInputLengthHint') }}</div>
                <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
              </div>
            </div>

            <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px" @click="addAction">
              <i class="fa-solid fa-plus"></i> {{ t('jobs.custom.addAction') }}
            </button>
          </div>
        </template>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelWindowStart') }}</label>
            <input v-model.number="form.scheduleWindowStart" class="form-input" type="number" placeholder="1400" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelWindowEnd') }}</label>
            <input v-model.number="form.scheduleWindowEnd" class="form-input" type="number" placeholder="1600" />
          </div>
        </div>

        <!-- checkin-specific fields (hidden when template controls them) -->
        <template v-if="form.jobType === 'checkin' && !form.templateId">
          <div class="form-row" style="align-items:start">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelStartCommand') }}</label>
              <select v-model="cmdDropdown" class="form-select">
                <option value="">({{ t('common.default') }}: /start)</option>
                <option value="/start">/start</option>
                <option value="/checkin">/checkin</option>
                <option value="custom">{{ t('common.custom') }}...</option>
              </select>
              <input v-if="cmdDropdown === 'custom'" v-model.trim="cmdCustom" class="form-input" style="margin-top:6px" placeholder="/mycommand" />
              <div style="font-size:11px;color:#aaa;margin-top:4px">{{ t('jobs.startCommandHint') }}</div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelCheckinButton') }}</label>
              <select v-model="btnDropdown" class="form-select">
                <option value="">({{ t('common.default') }}: 签到)</option>
                <option value="签到">签到</option>
                <option value="{aiBtn}" :disabled="aiKeyMissing">{{ t('jobs.aiBtnOption') }}{{ aiKeyMissing ? ' (' + t('jobs.noApiKey') + ')' : '' }}</option>
                <option value="{anyBtn}">{{ t('jobs.anyBtnOption') }}</option>
                <option value="custom">{{ t('common.custom') }}...</option>
              </select>
              <input v-if="btnDropdown === 'custom'" v-model.trim="btnCustom" class="form-input" style="margin-top:6px" placeholder="Custom button text" />
              <template v-if="btnDropdown === '{aiBtn}'">
                <input v-model.trim="btnAiHint" class="form-input" style="margin-top:6px" :placeholder="t('jobs.aiHintPlaceholder')" />
                <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.aiHintHint') }}</div>
                <div v-if="aiKeyMissing" style="font-size:11px;color:#e63946;margin-top:4px">{{ t('jobs.aiKeyWarning') }}</div>
              </template>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelReplyTimeout') }}</label>
              <input v-model.number="form.replyTimeoutMs" class="form-input" type="number" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
              <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" :disabled="!!form.templateId" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelSuccessContains') }}</label>
            <input v-model.trim="checkinSuccessContains" class="form-input" :placeholder="t('jobs.successContainsPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.successContainsHint') }}</div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelFailContains') }}</label>
            <input v-model.trim="checkinFailContains" class="form-input" :placeholder="t('jobs.failContainsPlaceholder')" />
            <div style="font-size:11px;color:#aaa;margin-top:3px">{{ t('jobs.failContainsHint') }}</div>
          </div>
        </template>

        <div v-if="form.jobType === 'embywatch' && !form.templateId" class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelRunEveryDays') }}</label>
            <input v-model.number="form.runEveryDays" class="form-input" type="number" min="1" max="365" style="max-width:120px" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.labelMaxRetries') }}</label>
            <input v-model.number="form.retryMax" class="form-input" type="number" min="1" max="10" />
          </div>
        </div>

        </div><!-- end modal-body -->
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showForm = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button v-if="editTarget && !editTarget.templateId" class="btn btn-ghost" @click="openExtract(editTarget)">
            <i class="fa-solid fa-file-export"></i> {{ t('jobs.extractToTemplate') }}
          </button>
          <button class="btn btn-primary" :disabled="saving" @click="saveJob">
            <i class="fa-solid fa-floppy-disk"></i> {{ saving ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Extract to Template modal -->
    <div v-if="extractSource" class="modal-backdrop">
      <div class="modal" style="width:400px">
        <h3 class="modal-title">{{ t('jobs.extractModalTitle') }}</h3>
        <div class="modal-body">
          <div v-if="extractError" class="error-msg">{{ extractError }}</div>
          <div class="form-group">
            <label class="form-label">{{ t('jobs.extractTemplateName') }} <span style="color:#e63946">*</span></label>
            <input v-model.trim="extractName" class="form-input" :placeholder="extractSource.name" @keyup.enter="confirmExtract" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="extractSource = null"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="extractSaving" @click="confirmExtract">
            <i class="fa-solid fa-file-export"></i> {{ extractSaving ? t('common.saving') : t('jobs.extractConfirm') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Disable confirmation modal -->
    <div v-if="confirmDisableJob" class="modal-backdrop">
      <div class="modal" style="width:360px">
        <h3 class="modal-title">{{ t('common.disable') }}</h3>
        <div class="modal-body">
          <p>{{ t('jobs.confirmDisable') }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmDisableJob = null"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeDisable"><i class="fa-solid fa-ban"></i> {{ t('common.disable') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk disable confirmation -->
    <div v-if="confirmBulkDisableJobs" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('common.disable') }}</h3>
        <div class="modal-body">
          <p>{{ t('jobs.confirmBulkDisable').replace('{n}', String(selectedJobIds.length)) }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmBulkDisableJobs = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeBulkDisableJobs"><i class="fa-solid fa-ban"></i> {{ t('common.disable') }}</button>
        </div>
      </div>
    </div>

    <!-- Bulk delete confirmation -->
    <div v-if="confirmBulkDeleteJobs" class="modal-backdrop">
      <div class="modal" style="width:380px">
        <h3 class="modal-title">{{ t('common.delete') }}</h3>
        <div class="modal-body">
          <p>{{ t('jobs.confirmBulkDelete').replace('{n}', String(selectedJobIds.length)) }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="confirmBulkDeleteJobs = false"><i class="fa-solid fa-xmark"></i> {{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="executeBulkDeleteJobs"><i class="fa-solid fa-trash"></i> {{ t('common.delete') }}</button>
        </div>
      </div>
    </div>

    <!-- Mobile action sheet -->
    <div v-if="actionMenuJob" class="action-sheet-backdrop" @click="actionMenuJob = null">
      <div class="action-sheet" @click.stop>
        <div class="action-sheet-header">{{ actionMenuJob.name }}</div>
        <button class="action-sheet-btn" :disabled="running.has(actionMenuJob.id)" @click="runNow(actionMenuJob.id); actionMenuJob = null">
          <i class="fa-solid fa-play"></i> {{ t('common.run') }}
        </button>
        <button class="action-sheet-btn" @click="openEdit(actionMenuJob); actionMenuJob = null">
          <i class="fa-solid fa-pen"></i> {{ t('common.edit') }}
        </button>
        <button class="action-sheet-btn" @click="openDuplicate(actionMenuJob); actionMenuJob = null">
          <i class="fa-solid fa-copy"></i> {{ t('common.duplicate') }}
        </button>
        <button class="action-sheet-btn" @click="toggleEnabled(actionMenuJob); actionMenuJob = null">
          <i :class="actionMenuJob.enabled ? 'fa-solid fa-ban' : 'fa-solid fa-circle-check'"></i>
          {{ actionMenuJob.enabled ? t('common.disable') : t('common.enable') }}
        </button>
        <button class="action-sheet-btn danger" @click="remove(actionMenuJob.id); actionMenuJob = null">
          <i class="fa-solid fa-trash"></i> {{ t('common.delete') }}
        </button>
        <div class="action-sheet-divider"></div>
        <button class="action-sheet-btn action-sheet-cancel" @click="actionMenuJob = null">
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { jobsApi, accountsApi, statusApi, settingsApi, logsApi, templatesApi, type Job, type JobTemplate, type Account, type ScheduleStatus, type Settings, type UAPreset, type EmbywatchConfig, type CustomConfig } from '../api/client';
import { t, locale } from '../i18n';
import { usePersistedRef } from '../composables/usePersistedRef';

type CustomActionForm = {
  type: 'send_command' | 'wait_reply' | 'delay' | 'click_button' | 'enter_captcha';
  content: string;
  contentDropdown: string;
  contentCustom: string;
  contentAiInputLength: string;
  maxWaitMs: number;
  waitMs: number;
  button: string;
  buttonDropdown: string;
  buttonCustom: string;
  buttonAiHint: string;
  maxRetries: number;
  captchaLength: string;
  successContains: string;
  failContains: string;
};

const jobs = ref<Job[]>([]);
const accounts = ref<Account[]>([]);
const templates = ref<JobTemplate[]>([]);
const scheduleStatus = ref<ScheduleStatus[]>([]);
const sortedScheduleStatus = computed(() =>
  [...scheduleStatus.value].sort((a, b) => a.nextRun.localeCompare(b.nextRun))
);
const settings = ref<Settings | null>(null);
const uaPresets = computed<UAPreset[]>(() => {
  try { return JSON.parse(settings.value?.ua_presets ?? '[]'); } catch { return []; }
});
const running = ref(new Set<number>());

const filterType = usePersistedRef<string>('bemby:jobs:filterType', '');
const filterAccountId = usePersistedRef<number | ''>('bemby:jobs:filterAccountId', '');
const filterBotUrlTpl = usePersistedRef<string>('bemby:jobs:filterBotUrlTpl', '');
const filterOptions = computed(() => [
  { value: '', label: t('common.all') },
  { value: 'checkin', label: t('logs.jobType.checkin') },
  { value: 'embywatch', label: t('logs.jobType.embywatch') },
  { value: 'custom', label: t('logs.jobType.custom') },
]);
const botUrlTplOptions = computed(() => {
  const botVals = [...new Set(jobs.value.map(j => j.botUsername).filter(Boolean))].sort().map(v => ({ value: `bot:${v}`, label: v }));
  const tplVals = templates.value.filter(t => jobs.value.some(j => j.templateId === t.id)).map(t => ({ value: `tpl:${t.id}`, label: `[T] ${t.name}` }));
  return [...botVals, ...tplVals];
});

const sortKey = usePersistedRef<string>('bemby:jobs:sortKey', '');
const sortDir = usePersistedRef<'asc' | 'desc'>('bemby:jobs:sortDir', 'asc');
const actionMenuJob = ref<Job | null>(null);
const confirmDisableJob = ref<Job | null>(null);
const selectedJobIds = ref<number[]>([]);
const allJobsSelected = computed(() => sortedJobs.value.length > 0 && sortedJobs.value.every(j => selectedJobIds.value.includes(j.id)));
const confirmBulkDisableJobs = ref(false);
const confirmBulkDeleteJobs = ref(false);

function setSort(key: string) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'asc';
  }
}

function sortIcon(key: string): string {
  if (sortKey.value !== key) return '↕';
  return sortDir.value === 'asc' ? '↑' : '↓';
}

const sortedJobs = computed(() => {
  const filtered = jobs.value.filter(j => {
    if (filterType.value && j.jobType !== filterType.value) return false;
    if (filterAccountId.value !== '' && j.accountId !== filterAccountId.value) return false;
    if (filterBotUrlTpl.value) {
      if (filterBotUrlTpl.value.startsWith('bot:')) {
        if (j.botUsername !== filterBotUrlTpl.value.slice(4)) return false;
      } else if (filterBotUrlTpl.value.startsWith('tpl:')) {
        if (j.templateId !== Number(filterBotUrlTpl.value.slice(4))) return false;
      }
    }
    return true;
  });
  if (!sortKey.value) return filtered;
  return [...filtered].sort((a, b) => {
    let av: string | number, bv: string | number;
    switch (sortKey.value) {
      case 'name':    av = a.name.toLowerCase();                    bv = b.name.toLowerCase(); break;
      case 'account': av = (a.accountName ?? '').toLowerCase();     bv = (b.accountName ?? '').toLowerCase(); break;
      case 'type':    av = a.jobType;                               bv = b.jobType; break;
      case 'botUrl':  av = a.botUsername.toLowerCase();             bv = b.botUsername.toLowerCase(); break;
      case 'window':  av = a.scheduleWindowStart;                   bv = b.scheduleWindowStart; break;
      case 'enabled': av = a.enabled ? 0 : 1;                      bv = b.enabled ? 0 : 1; break;
      default:        return 0;
    }
    if (av < bv) return sortDir.value === 'asc' ? -1 : 1;
    if (av > bv) return sortDir.value === 'asc' ? 1 : -1;
    return 0;
  });
});

function jobTypeBadge(type: string) {
  const map: Record<string, string> = {
    checkin: 'badge badge-blue',
    embywatch: 'badge badge-purple',
    custom: 'badge badge-amber',
  };
  return map[type] ?? 'badge badge-grey';
}
const pollTimers = new Map<number, ReturnType<typeof setTimeout>>();

const showForm = ref(false);
const editTarget = ref<Job | null>(null);
const customActions = ref<CustomActionForm[]>([]);
const customJobMaxRetries = ref(1);

const form = reactive({
  name: '',
  accountId: null as number | null,
  jobType: 'checkin' as 'checkin' | 'embywatch' | 'custom',
  botUsername: '',
  scheduleWindowStart: 1000,
  scheduleWindowEnd: 2200,
  timezone: 'Australia/Sydney',
  replyTimeoutMs: 40000,
  retryMax: 5,
  enabled: true,
  templateId: null as number | null,
  runEveryDays: 1,
});

const linkedTemplate = computed(() => templates.value.find(t => t.id === form.templateId) ?? null);

const extractSource = ref<Job | null>(null);
const extractName = ref('');
const extractError = ref('');
const extractSaving = ref(false);
const embyCfg = reactive<{ username: string; password: string; playDuration: number | string; userAgent: string; markWatched: boolean }>({
  username: '',
  password: '',
  playDuration: '',
  userAgent: '',
  markWatched: true,
});
const embyUaDropdown = ref('');
const embyServer = reactive<{ protocol: 'https' | 'http'; host: string; port: number | '' }>({
  protocol: 'https',
  host: '',
  port: 443,
});
const formError = ref('');
const saving = ref(false);
const aiKeyMissing = computed(() => !settings.value?.ai_api_key);

const CMD_PRESETS = new Set(['', '/start', '/checkin'])
const ACTION_CMD_PRESETS = new Set(['/start', '/checkin'])
const ACTION_BTN_PRESETS = new Set(['签到', '{anyBtn}'])
const BTN_PRESETS = new Set(['', '签到', '{aiBtn}', '{anyBtn}'])
const cmdDropdown = ref('')
const cmdCustom = ref('')
const btnDropdown = ref('')
const btnCustom = ref('')
const btnAiHint = ref('')
const checkinSuccessContains = ref('')
const checkinFailContains = ref('')

function setCmdState(val: string) {
  if (CMD_PRESETS.has(val)) { cmdDropdown.value = val; cmdCustom.value = ''; }
  else { cmdDropdown.value = 'custom'; cmdCustom.value = val; }
}
function setBtnState(val: string) {
  const aiMatch = val.match(/^\{aiBtn:(.+)\}$/);
  if (aiMatch) {
    btnDropdown.value = '{aiBtn}'; btnAiHint.value = aiMatch[1].trim(); btnCustom.value = '';
  } else if (BTN_PRESETS.has(val)) {
    btnDropdown.value = val; btnCustom.value = ''; btnAiHint.value = '';
  } else {
    btnDropdown.value = 'custom'; btnCustom.value = val; btnAiHint.value = '';
  }
}

function setUaState(ua: string) {
  if (!ua) { embyUaDropdown.value = ''; return; }
  const match = uaPresets.value.find(p => p.value === ua);
  embyUaDropdown.value = match ? match.name : '__custom__';
}

function onUaDropdownChange() {
  if (embyUaDropdown.value === '' ) { embyCfg.userAgent = ''; return; }
  if (embyUaDropdown.value === '__custom__') return;
  const preset = uaPresets.value.find(p => p.name === embyUaDropdown.value);
  if (preset) embyCfg.userAgent = preset.value;
}

function onJobTypeChange() {
  Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true });
  Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
  embyUaDropdown.value = '';
  form.accountId = (form.jobType === 'checkin' || form.jobType === 'custom')
    ? (accounts.value[0]?.id ?? null)
    : null;
  form.runEveryDays = 1;
  customActions.value = [];
  customJobMaxRetries.value = 1;
  btnAiHint.value = '';
  checkinSuccessContains.value = '';
  checkinFailContains.value = '';
  setCmdState(''); setBtnState('');
}

function defaultAction(): CustomActionForm {
  return { type: 'send_command', content: '/start', contentDropdown: '/start', contentCustom: '', contentAiInputLength: '', maxWaitMs: 30000, waitMs: 2000, button: '签到', buttonDropdown: '签到', buttonCustom: '', buttonAiHint: '', maxRetries: 3, captchaLength: '', successContains: '', failContains: '' };
}

function addAction() {
  customActions.value.push(defaultAction());
}

function removeAction(i: number) {
  customActions.value.splice(i, 1);
}

function moveUp(i: number) {
  if (i === 0) return;
  const arr = customActions.value;
  [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
}

function moveDown(i: number) {
  const arr = customActions.value;
  if (i >= arr.length - 1) return;
  [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
}

onMounted(async () => {
  await Promise.all([loadJobs(), loadAccounts(), loadStatus(), loadSettings(), loadTemplates()]);
});

async function loadSettings() {
  try { settings.value = await settingsApi.get(); } catch { /* ignore */ }
}

async function loadTemplates() {
  try { templates.value = await templatesApi.list(); } catch { /* ignore */ }
}

function applyTemplate(tpl: JobTemplate) {
  form.jobType = tpl.jobType;
  form.botUsername = tpl.botUsername;
  form.timezone = tpl.timezone;
  form.replyTimeoutMs = tpl.replyTimeoutMs;
  form.retryMax = tpl.retryMax;
  setCmdState(tpl.startCommand === '/start' ? '' : (tpl.startCommand ?? ''));
  setBtnState(tpl.checkinButton === '签到' ? '' : (tpl.checkinButton ?? ''));
  if (tpl.jobType === 'embywatch') {
    const m = tpl.botUsername.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/);
    Object.assign(embyServer, { protocol: (m?.[1] ?? 'https') as 'https' | 'http', host: m?.[2] ?? '', port: m?.[3] ? Number(m[3]) : 443 });
    if (tpl.config) {
      try {
        let c = JSON.parse(tpl.config) as EmbywatchConfig | string;
        if (typeof c === 'string') c = JSON.parse(c) as EmbywatchConfig;
        // username/password are job-specific; only apply playback settings from template
        Object.assign(embyCfg, { playDuration: c.playDuration ?? '', userAgent: c.userAgent ?? '', markWatched: c.markWatched !== false });
        setUaState(c.userAgent ?? '');
      } catch { /* ignore */ }
    }
  } else if (tpl.jobType === 'custom') {
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    if (tpl.config) {
      try {
        const cfg = JSON.parse(tpl.config) as CustomConfig;
        customJobMaxRetries.value = cfg.maxRetries ?? 1;
        customActions.value = cfg.actions.map(a => {
          const base = defaultAction();
          if (a.type === 'send_command') {
            const aiInputMatch = a.content.match(/^\{aiInput(?::(\d+))?\}$/);
            if (aiInputMatch) return { ...base, type: 'send_command' as const, content: a.content, contentDropdown: '{aiInput}', contentCustom: '', contentAiInputLength: aiInputMatch[1] ?? '', maxRetries: a.maxRetries ?? 0 };
            const contentDropdown = ACTION_CMD_PRESETS.has(a.content) ? a.content : 'custom';
            return { ...base, type: 'send_command' as const, content: a.content, contentDropdown, contentCustom: contentDropdown === 'custom' ? a.content : '', contentAiInputLength: '', maxRetries: a.maxRetries ?? 0 };
          }
          if (a.type === 'wait_reply') return { ...base, type: 'wait_reply' as const, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0 };
          if (a.type === 'delay') return { ...base, type: 'delay' as const, waitMs: a.waitMs };
          if (a.type === 'enter_captcha') return { ...base, type: 'enter_captcha' as const, maxWaitMs: a.maxWaitMs, captchaLength: String(a.captchaLength ?? ''), maxRetries: a.maxRetries ?? 0 };
          if (a.type === 'click_button') {
            const aiMatch = a.button.match(/^\{aiBtn(?::(.+))?\}$/);
            let buttonDropdown: string, buttonCustom = '', buttonAiHint = '';
            if (aiMatch) { buttonDropdown = '{aiBtn}'; buttonAiHint = aiMatch[1]?.trim() ?? ''; }
            else if (ACTION_BTN_PRESETS.has(a.button)) { buttonDropdown = a.button; }
            else { buttonDropdown = 'custom'; buttonCustom = a.button; }
            return { ...base, type: 'click_button' as const, button: a.button, buttonDropdown, buttonCustom, buttonAiHint, maxRetries: a.maxRetries, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '' };
          }
          return base;
        });
      } catch { customActions.value = []; customJobMaxRetries.value = 1; }
    }
  } else {
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true });
    customActions.value = [];
  }
}

function onTemplateChange() {
  const tpl = linkedTemplate.value;
  if (!tpl) return;
  applyTemplate(tpl);
  // accountId is job-specific — never reset it when a template is assigned
}

async function loadJobs() {
  jobs.value = await jobsApi.list();
}

async function loadAccounts() {
  accounts.value = await accountsApi.list();
}

async function loadStatus() {
  try { scheduleStatus.value = await statusApi.get(); } catch { /* ignore */ }
}

function fmtWindow(start: number, end: number) {
  const fmt = (n: number) => `${String(Math.floor(n / 100)).padStart(2, '0')}:${String(n % 100).padStart(2, '0')}`;
  return `${fmt(start)} – ${fmt(end)}`;
}

function fmtDateTime(iso: string) {
  const localeMap: Record<string, string> = { en: 'en-AU', zh: 'zh-CN' };
  return new Date(iso).toLocaleString(localeMap[locale.value] ?? 'en-AU', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function openAdd() {
  editTarget.value = null;
  Object.assign(form, {
    name: '', accountId: accounts.value[0]?.id ?? null,
    jobType: 'checkin', botUsername: '',
    scheduleWindowStart: 1000, scheduleWindowEnd: 2200,
    timezone: settings.value?.default_timezone ?? 'Australia/Sydney',
    replyTimeoutMs: 40000,
    retryMax: Number(settings.value?.default_max_retry ?? 5),
    enabled: true,
    templateId: null,
    runEveryDays: 1,
  });
  Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true });
  Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
  embyUaDropdown.value = '';
  customActions.value = [];
  checkinSuccessContains.value = '';
  checkinFailContains.value = '';
  setCmdState(''); setBtnState('');
  formError.value = '';
  showForm.value = true;
}

function openEdit(j: Job) {
  editTarget.value = j;
  Object.assign(form, {
    name: j.name, accountId: j.accountId, jobType: j.jobType,
    botUsername: j.botUsername, scheduleWindowStart: j.scheduleWindowStart,
    scheduleWindowEnd: j.scheduleWindowEnd, timezone: j.timezone,
    replyTimeoutMs: j.replyTimeoutMs, retryMax: j.retryMax, enabled: j.enabled,
    templateId: j.templateId ?? null,
    runEveryDays: j.runEveryDays ?? 1,
  });
  setCmdState(j.startCommand === '/start' ? '' : (j.startCommand ?? ''));
  setBtnState(j.checkinButton === '签到' ? '' : (j.checkinButton ?? ''));
  checkinSuccessContains.value = '';
  checkinFailContains.value = '';
  if (j.jobType === 'checkin' && j.config) {
    try {
      let cfg = JSON.parse(j.config);
      if (typeof cfg === 'string') cfg = JSON.parse(cfg);
      checkinSuccessContains.value = cfg.successContains ?? '';
      checkinFailContains.value = cfg.failContains ?? '';
    } catch { /* ignore */ }
  }
  if (j.jobType === 'embywatch') {
    // Parse stored URL back into protocol / host / port fields
    const m = j.botUsername.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/);
    Object.assign(embyServer, {
      protocol: (m?.[1] ?? 'https') as 'https' | 'http',
      host: m?.[2] ?? j.botUsername,
      port: m?.[3] ? Number(m[3]) : 443,
    });
    if (j.config) {
      try {
        let c = JSON.parse(j.config) as EmbywatchConfig | string;
        // Migrate legacy double-encoded records
        if (typeof c === 'string') c = JSON.parse(c) as EmbywatchConfig;
        Object.assign(embyCfg, {
          username: c.username ?? '',
          password: c.password ?? '',
          playDuration: c.playDuration ?? '',
          userAgent: c.userAgent ?? '',
          markWatched: c.markWatched !== false,
        });
        setUaState(c.userAgent ?? '');
      } catch {
        Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true });
        embyUaDropdown.value = '';
      }
    } else {
      Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true });
      embyUaDropdown.value = '';
    }
  } else if (j.jobType === 'custom') {
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    if (j.config) {
      try {
        const cfg = JSON.parse(j.config) as CustomConfig;
        customJobMaxRetries.value = cfg.maxRetries ?? 1;
        customActions.value = cfg.actions.map(a => {
          const base = defaultAction();
          if (a.type === 'send_command') {
            const aiInputMatch = a.content.match(/^\{aiInput(?::(\d+))?\}$/);
            if (aiInputMatch) {
              return { ...base, type: 'send_command', content: a.content, contentDropdown: '{aiInput}', contentCustom: '', contentAiInputLength: aiInputMatch[1] ?? '', maxRetries: a.maxRetries ?? 0 };
            }
            const contentDropdown = ACTION_CMD_PRESETS.has(a.content) ? a.content : 'custom';
            return { ...base, type: 'send_command', content: a.content, contentDropdown, contentCustom: contentDropdown === 'custom' ? a.content : '', contentAiInputLength: '', maxRetries: a.maxRetries ?? 0 };
          }
          if (a.type === 'wait_reply') return { ...base, type: 'wait_reply', maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '', maxRetries: a.maxRetries ?? 0 };
          if (a.type === 'delay') return { ...base, type: 'delay', waitMs: a.waitMs };
          if (a.type === 'enter_captcha') return { ...base, type: 'enter_captcha', maxWaitMs: a.maxWaitMs, captchaLength: String(a.captchaLength ?? ''), maxRetries: a.maxRetries ?? 0 };
          if (a.type === 'click_button') {
            const aiMatch = a.button.match(/^\{aiBtn(?::(.+))?\}$/);
            let buttonDropdown: string, buttonCustom = '', buttonAiHint = '';
            if (aiMatch) {
              buttonDropdown = '{aiBtn}'; buttonAiHint = aiMatch[1]?.trim() ?? '';
            } else if (ACTION_BTN_PRESETS.has(a.button)) {
              buttonDropdown = a.button;
            } else {
              buttonDropdown = 'custom'; buttonCustom = a.button;
            }
            return { ...base, type: 'click_button', button: a.button, buttonDropdown, buttonCustom, buttonAiHint, maxRetries: a.maxRetries, maxWaitMs: a.maxWaitMs, successContains: a.successContains ?? '', failContains: a.failContains ?? '' };
          }
          return base;
        });
      } catch { customActions.value = []; customJobMaxRetries.value = 1; }
    } else {
      customActions.value = [];
      customJobMaxRetries.value = 1;
    }
  } else {
    Object.assign(embyCfg, { username: '', password: '', playDuration: '', userAgent: '', markWatched: true });
    Object.assign(embyServer, { protocol: 'https', host: '', port: 443 });
    customActions.value = [];
  }
  formError.value = '';
  showForm.value = true;
}

function openDuplicate(j: Job) {
  openEdit(j);
  editTarget.value = null;
  form.name = `${j.name} (copy)`;
}

function handleEmbyHostPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text')?.trim();
  if (!text) return;
  // Match optional protocol, host, optional port, optional path
  const match = text.match(/^(?:(https?):\/\/)?([^:/\s]+)(?::(\d+))?(?:\/.*)?$/i);
  if (!match) return;
  const [, proto, host, portStr] = match;
  // Plain hostname with no protocol or port — nothing to split, paste normally
  if (!proto && !portStr) return;
  event.preventDefault();
  if (proto === 'https' || proto === 'http') embyServer.protocol = proto as 'https' | 'http';
  embyServer.host = host;
  if (portStr) embyServer.port = Number(portStr);
}

function buildConfig(): EmbywatchConfig | CustomConfig | Record<string, string> | null {
  if (form.jobType === 'embywatch') {
    if (form.templateId) {
      // Template provides all settings; job only stores credentials
      return { username: embyCfg.username, password: embyCfg.password } as EmbywatchConfig;
    }
    const cfg: EmbywatchConfig = { username: embyCfg.username, password: embyCfg.password };
    if (embyCfg.playDuration !== '') cfg.playDuration = Number(embyCfg.playDuration as string | number);
    if (embyCfg.userAgent) cfg.userAgent = embyCfg.userAgent;
    cfg.markWatched = embyCfg.markWatched;
    return cfg;
  }
  if (form.jobType === 'custom') {
    const cfg: CustomConfig = {
      actions: customActions.value.map(a => {
        if (a.type === 'send_command') {
          let content: string;
          if (a.contentDropdown === '{aiInput}') {
            content = a.contentAiInputLength ? `{aiInput:${a.contentAiInputLength}}` : '{aiInput}';
          } else {
            content = a.contentDropdown === 'custom' ? a.contentCustom : a.contentDropdown;
          }
          return { type: 'send_command' as const, content, ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}) };
        }
        if (a.type === 'wait_reply') {
          return {
            type: 'wait_reply' as const,
            maxWaitMs: a.maxWaitMs,
            ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
            ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
            ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}),
          };
        }
        if (a.type === 'delay') return { type: 'delay' as const, waitMs: a.waitMs };
        if (a.type === 'enter_captcha') {
          const captchaLength = a.captchaLength ? parseInt(a.captchaLength) || undefined : undefined;
          return { type: 'enter_captcha' as const, maxWaitMs: a.maxWaitMs, captchaLength, ...(a.maxRetries > 0 ? { maxRetries: a.maxRetries } : {}) };
        }
        let button: string;
        if (a.buttonDropdown === 'custom') button = a.buttonCustom;
        else if (a.buttonDropdown === '{aiBtn}') button = a.buttonAiHint.trim() ? `{aiBtn:${a.buttonAiHint.trim()}}` : '{aiBtn}';
        else button = a.buttonDropdown || '签到';
        return {
          type: 'click_button' as const,
          button,
          maxRetries: a.maxRetries,
          maxWaitMs: a.maxWaitMs,
          ...(a.successContains.trim() ? { successContains: a.successContains.trim() } : {}),
          ...(a.failContains.trim() ? { failContains: a.failContains.trim() } : {}),
        };
      }),
    };
    if (customJobMaxRetries.value > 1) cfg.maxRetries = customJobMaxRetries.value;
    return cfg;
  }
  if (form.jobType === 'checkin') {
    const s = checkinSuccessContains.value.trim();
    const f = checkinFailContains.value.trim();
    if (s || f) return { ...(s ? { successContains: s } : {}), ...(f ? { failContains: f } : {}) };
  }
  return null;
}

async function saveJob() {
  formError.value = '';
  if (!form.name) { formError.value = t('jobs.errors.nameRequired'); return; }
  if ((form.jobType === 'checkin' || form.jobType === 'custom') && !form.accountId) { formError.value = t('jobs.errors.accountRequired'); return; }
  if (form.jobType === 'custom') {
    if (!form.botUsername) { formError.value = t('jobs.errors.botRequired'); return; }
    if (customActions.value.length === 0) { formError.value = t('jobs.errors.customActionsRequired'); return; }
  }
  if (form.jobType === 'embywatch') {
    if (!embyServer.host) { formError.value = t('jobs.errors.hostRequired'); return; }
    const portPart = (embyServer.port as number | string) !== '' ? `:${embyServer.port}` : '';
    // Strip any accidental protocol prefix the user may have typed into the host field
    form.botUsername = `${embyServer.protocol}://${embyServer.host.replace(/^https?:\/\//, '')}${portPart}`;
  }
  if (!form.botUsername) { formError.value = t('jobs.errors.botRequired'); return; }
  if (form.jobType === 'checkin') form.botUsername = form.botUsername.replace(/^@+/, '');
  if (form.jobType === 'embywatch' && (!embyCfg.username || !embyCfg.password)) {
    formError.value = t('jobs.errors.embyCredRequired');
    return;
  }
  saving.value = true;
  try {
    const rawCfg = buildConfig();
    const startCommand = (cmdDropdown.value === 'custom' ? cmdCustom.value : cmdDropdown.value) || undefined;
    const resolvedAiBtn = btnAiHint.value.trim() ? `{aiBtn:${btnAiHint.value.trim()}}` : '{aiBtn}';
    const checkinButton = btnDropdown.value === '{aiBtn}'
      ? resolvedAiBtn
      : (btnDropdown.value === 'custom' ? btnCustom.value : btnDropdown.value) || undefined;
    const payload = {
      ...form,
      // config is serialised by the backend; pass as-is
      config: rawCfg as unknown as string | null,
      startCommand,
      checkinButton,
      templateId: form.templateId ?? null,
    };
    if (editTarget.value) {
      await jobsApi.update(editTarget.value.id, payload);
    } else {
      await jobsApi.create(payload);
    }
    showForm.value = false;
    await Promise.all([loadJobs(), loadStatus()]);
  } catch (err: any) {
    formError.value = err.response?.data?.error ?? t('common.saveFailed');
  } finally {
    saving.value = false;
  }
}

function openExtract(j: Job) {
  extractSource.value = j;
  extractName.value = j.name;
  extractError.value = '';
}

async function confirmExtract() {
  const job = extractSource.value;
  if (!job) return;
  if (!extractName.value) { extractError.value = t('jobs.errors.nameRequired'); return; }
  extractSaving.value = true;
  extractError.value = '';
  try {
    const tpl = await templatesApi.create({
      name: extractName.value,
      jobType: job.jobType,
      botUsername: job.botUsername,
      timezone: job.timezone,
      replyTimeoutMs: job.replyTimeoutMs,
      retryMax: job.retryMax,
      config: job.config ? JSON.parse(job.config) as unknown as string | null : null,
      startCommand: job.startCommand,
      checkinButton: job.checkinButton,
    });
    await jobsApi.update(job.id, { templateId: tpl.id });
    extractSource.value = null;
    showForm.value = false;
    await Promise.all([loadJobs(), loadTemplates()]);
  } catch (err: any) {
    extractError.value = err.response?.data?.error ?? t('common.saveFailed');
  } finally {
    extractSaving.value = false;
  }
}

async function toggleEnabled(j: Job) {
  if (j.enabled) {
    confirmDisableJob.value = j;
    return;
  }
  await jobsApi.update(j.id, { enabled: true });
  await Promise.all([loadJobs(), loadStatus()]);
}

async function executeDisable() {
  if (!confirmDisableJob.value) return;
  await jobsApi.update(confirmDisableJob.value.id, { enabled: false });
  await Promise.all([loadJobs(), loadStatus()]);
  confirmDisableJob.value = null;
}

async function remove(id: number) {
  if (!confirm(t('jobs.confirmDelete'))) return;
  await jobsApi.delete(id);
  selectedJobIds.value = selectedJobIds.value.filter(i => i !== id);
  await loadJobs();
}

function toggleAllJobs() {
  selectedJobIds.value = allJobsSelected.value ? [] : sortedJobs.value.map(j => j.id);
}

function toggleJobSelect(id: number) {
  const idx = selectedJobIds.value.indexOf(id);
  if (idx === -1) selectedJobIds.value.push(id);
  else selectedJobIds.value.splice(idx, 1);
}

async function bulkEnableJobs() {
  await Promise.all(selectedJobIds.value.map(id => jobsApi.update(id, { enabled: true })));
  await Promise.all([loadJobs(), loadStatus()]);
  selectedJobIds.value = [];
}

async function executeBulkDisableJobs() {
  await Promise.all(selectedJobIds.value.map(id => jobsApi.update(id, { enabled: false })));
  await Promise.all([loadJobs(), loadStatus()]);
  confirmBulkDisableJobs.value = false;
  selectedJobIds.value = [];
}

async function executeBulkDeleteJobs() {
  await Promise.all(selectedJobIds.value.map(id => jobsApi.delete(id)));
  await loadJobs();
  confirmBulkDeleteJobs.value = false;
  selectedJobIds.value = [];
}

function stopRunning(jobId: number) {
  running.value.delete(jobId);
  running.value = new Set(running.value);
  const timer = pollTimers.get(jobId);
  if (timer) { clearTimeout(timer); pollTimers.delete(jobId); }
}

function schedulePoll(jobId: number, logId: number) {
  const timer = setTimeout(async () => {
    try {
      const log = await logsApi.getOne(logId);
      if (log.status === 'running') {
        schedulePoll(jobId, logId);
      } else {
        stopRunning(jobId);
      }
    } catch {
      stopRunning(jobId);
    }
  }, 3000);
  pollTimers.set(jobId, timer);
}

async function runNow(id: number) {
  running.value.add(id);
  running.value = new Set(running.value);
  try {
    const { logId } = await jobsApi.run(id);
    schedulePoll(id, logId);
  } catch (err: any) {
    alert(err.response?.data?.error ?? 'Trigger failed');
    stopRunning(id);
  }
}

onUnmounted(() => {
  for (const timer of pollTimers.values()) clearTimeout(timer);
});
</script>

<style scoped>
.custom-action-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  background: #fafafa;
}

.custom-action-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.custom-action-num {
  min-width: 20px;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: #aaa;
}

.custom-action-type-select {
  flex: 1;
}

.custom-action-params {
  padding-left: 26px;
}

.th-sort {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.th-sort:hover {
  background: #f0f4ff;
}

.th-sort.sort-active {
  color: #3730a3;
}

.sort-icon {
  font-size: 10px;
  color: #ccc;
  margin-left: 2px;
}

.th-sort.sort-active .sort-icon {
  color: #6366f1;
}

tbody tr:nth-child(even):not(.row-selected) td {
  background: #f0f2f5;
}

.row-selected td {
  background: #bfdbfe;
}

.badge-tpl {
  display: inline-block;
  font-size: 9px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 3px;
  background: #e0e7ff;
  color: #4338ca;
  margin-left: 5px;
  vertical-align: middle;
  letter-spacing: 0.03em;
}

.template-summary-card {
  margin-bottom: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f0f4ff;
  border: 1px solid #c7d2fe;
}

.template-summary-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.template-summary-detail {
  font-size: 13px;
  color: #4b5563;
}

/* ── Mobile action sheet ──────────────────────────────────────────────────────── */

.action-sheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 200;
  display: flex;
  align-items: flex-end;
}

.action-sheet {
  background: #fff;
  border-radius: 16px 16px 0 0;
  width: 100%;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.12);
}

.action-sheet-header {
  padding: 14px 20px 10px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #888;
  border-bottom: 1px solid #f0f0f0;
}

.action-sheet-btn {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 15px 20px;
  background: none;
  border: none;
  font-size: 15px;
  color: #1a1a2e;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.action-sheet-btn:not(:disabled):active {
  background: #f5f5f5;
}

.action-sheet-btn.danger {
  color: #e63946;
}

.action-sheet-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-sheet-divider {
  height: 1px;
  background: #f0f0f0;
  margin: 4px 0;
}

.action-sheet-cancel {
  color: #888;
  font-weight: 500;
}

.bulk-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 16px;
  border-top: 1px solid #f0f0f0;
  background: #fafafa;
}

.bulk-count {
  font-size: 13px;
  color: #666;
  white-space: nowrap;
}
</style>
