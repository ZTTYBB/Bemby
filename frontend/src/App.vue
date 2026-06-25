<template>
  <div v-if="isPublicRoute" class="full-page">
    <router-view />
  </div>
  <div v-else class="layout">
    <header class="mobile-header">
      <button class="hamburger-btn" @click="sidebarOpen = !sidebarOpen" :aria-expanded="sidebarOpen">
        <i class="fa-solid fa-bars"></i>
      </button>
      <div class="mobile-header-right">
        <button class="lang-btn" @click="setLocale(locale === 'zh' ? 'en' : 'zh')">
          {{ locale === 'zh' ? 'EN' : '中文' }}
        </button>
        <div class="mobile-header-brand">
          <img src="/logo.png" alt="Bemby" class="mobile-logo-img" />
          <span class="mobile-brand-name">BEMBY</span>
          <span class="mobile-version">v{{ APP_VERSION }}</span>
        </div>
      </div>
    </header>

    <div v-if="sidebarOpen" class="sidebar-backdrop" @click="sidebarOpen = false" />

    <nav class="sidebar" :class="{ 'is-open': sidebarOpen }">
      <div class="sidebar-title">
        <a class="sidebar-brand" href="https://github.com/liveinaus/Bemby" target="_blank" rel="noopener noreferrer">
          <img src="/logo.png" alt="Bemby" class="sidebar-logo" />
          <div class="sidebar-brand-text">
            <span class="sidebar-name">BEMBY</span>
            <span class="sidebar-version">v{{ APP_VERSION }}</span>
          </div>
        </a>
      </div>
      <a class="nav-link" href="#" :class="{ active: currentView === 'accounts' }" @click.prevent="setView('accounts')"><i class="fa-solid fa-users"></i>{{ t('nav.accounts') }}</a>
      <a class="nav-link" href="#" :class="{ active: showMessengerInline }" @click.prevent="openMessenger()"><i class="fa-brands fa-telegram"></i>{{ t('nav.messenger') }}</a>
      <a class="nav-link" href="#" :class="{ active: currentView === 'jobs' }" @click.prevent="setView('jobs')"><i class="fa-solid fa-robot"></i>{{ t('nav.jobs') }}</a>
      <a class="nav-link" href="#" :class="{ active: currentView === 'templates' }" @click.prevent="setView('templates')"><i class="fa-solid fa-layer-group"></i>{{ t('nav.templates') }}</a>
      <a class="nav-link" href="#" :class="{ active: currentView === 'logs' }" @click.prevent="setView('logs')"><i class="fa-solid fa-scroll"></i>{{ t('nav.logs') }}</a>
      <a class="nav-link" href="#" :class="{ active: currentView === 'settings' }" @click.prevent="setView('settings')"><i class="fa-solid fa-gear"></i>{{ t('nav.settings') }}</a>
      <a class="nav-link" href="#" :class="{ active: currentView === 'help' }" @click.prevent="setView('help')"><i class="fa-solid fa-circle-question"></i>{{ t('nav.help') }}</a>
      <div class="sidebar-footer">
        <div class="lang-switcher">
          <button class="lang-btn" @click="setLocale(locale === 'zh' ? 'en' : 'zh')">
            {{ locale === 'zh' ? 'EN' : '中文' }}
          </button>
        </div>
        <a class="github-link" href="https://github.com/liveinaus/Bemby" target="_blank" rel="noopener noreferrer">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          GitHub
        </a>
        <button class="logout-btn" @click="logout"><i class="fa-solid fa-right-from-bracket"></i> {{ t('nav.logout') }}</button>
      </div>
    </nav>

    <main class="main">
      <TgClientPopup
        v-if="showMessengerInline"
        :inline="true"
        @close="closeMessengerInline"
      />
      <component v-else :is="currentComponent" />
    </main>
  </div>

  <!-- Desktop popup (non-mobile only) -->
  <TgClientPopup v-if="showMessenger" @close="showMessenger = false" />
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, type Component } from 'vue';
import TgClientPopup from './components/TgClientPopup.vue';
import { useRoute, useRouter } from 'vue-router';
import { version as APP_VERSION } from '../package.json';
import { t, locale, setLocale } from './i18n';
import AccountsView from './views/AccountsView.vue';
import JobsView from './views/JobsView.vue';
import TemplatesView from './views/TemplatesView.vue';
import LogsView from './views/LogsView.vue';
import SettingsView from './views/SettingsView.vue';
import HelpView from './views/HelpView.vue';

type ViewName = 'accounts' | 'jobs' | 'templates' | 'settings' | 'logs' | 'help';

const LAST_VIEW_KEY = 'bemby:lastView';
const VALID_VIEWS: ViewName[] = ['accounts', 'jobs', 'templates', 'settings', 'logs', 'help'];

const viewComponents: Record<ViewName, Component> = {
  accounts: AccountsView,
  jobs: JobsView,
  templates: TemplatesView,
  settings: SettingsView,
  logs: LogsView,
  help: HelpView,
};

const savedView = localStorage.getItem(LAST_VIEW_KEY) as ViewName;
const currentView = ref<ViewName>(VALID_VIEWS.includes(savedView) ? savedView : 'accounts');
const currentComponent = computed(() => viewComponents[currentView.value]);

// Track whether the messenger is shown inline (mobile) or as a popup (desktop)
const mq = window.matchMedia('(max-width: 768px)');
const isMobile = ref(mq.matches);
const mqHandler = (e: MediaQueryListEvent) => { isMobile.value = e.matches; };
mq.addEventListener('change', mqHandler);
onUnmounted(() => mq.removeEventListener('change', mqHandler));

const showMessenger = ref(false);       // desktop popup
const showMessengerInline = ref(false); // mobile inline view

function openMessenger() {
  sidebarOpen.value = false;
  if (isMobile.value) {
    showMessengerInline.value = true;
  } else {
    showMessenger.value = true;
  }
}

function closeMessengerInline() {
  showMessengerInline.value = false;
}

function setView(view: ViewName) {
  currentView.value = view;
  localStorage.setItem(LAST_VIEW_KEY, view);
  showMessengerInline.value = false;
  sidebarOpen.value = false;
}

const route = useRoute();
const router = useRouter();

const isPublicRoute = computed(() => route.meta.public === true);
const sidebarOpen = ref(false);

function logout() {
  localStorage.removeItem('token');
  router.push('/login');
}
</script>
