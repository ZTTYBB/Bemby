<template>
  <div v-if="isPublicRoute" class="full-page">
    <router-view />
  </div>
  <div v-else class="layout">
    <header class="mobile-header">
      <div class="mobile-header-brand">
        <img src="/logo.png" alt="Bemby" class="mobile-logo-img" />
        <span class="mobile-version">v{{ APP_VERSION }}</span>
      </div>
      <div class="mobile-header-actions">
        <button class="lang-btn" @click="setLocale(locale === 'zh' ? 'en' : 'zh')">
          {{ locale === 'zh' ? 'EN' : '中文' }}
        </button>
        <button class="hamburger-btn" @click="sidebarOpen = !sidebarOpen" :aria-expanded="sidebarOpen">
          <span></span><span></span><span></span>
        </button>
      </div>
    </header>

    <div v-if="sidebarOpen" class="sidebar-backdrop" @click="sidebarOpen = false" />

    <nav class="sidebar" :class="{ 'is-open': sidebarOpen }">
      <div class="sidebar-title">
        <img src="/logo.png" alt="Bemby" class="sidebar-logo" />
        <span class="sidebar-version">v{{ APP_VERSION }}</span>
      </div>
      <router-link class="nav-link" to="/accounts" @click="sidebarOpen = false">{{ t('nav.accounts') }}</router-link>
      <router-link class="nav-link" to="/jobs" @click="sidebarOpen = false">{{ t('nav.jobs') }}</router-link>
      <router-link class="nav-link" to="/settings" @click="sidebarOpen = false">{{ t('nav.settings') }}</router-link>
      <router-link class="nav-link" to="/logs" @click="sidebarOpen = false">{{ t('nav.logs') }}</router-link>
      <router-link class="nav-link" to="/help" @click="sidebarOpen = false">{{ t('nav.help') }}</router-link>
      <div class="lang-switcher">
        <button class="lang-btn" @click="setLocale(locale === 'zh' ? 'en' : 'zh')">
          {{ locale === 'zh' ? 'EN' : '中文' }}
        </button>
      </div>
      <div class="sidebar-footer">
        <a class="github-link" href="https://github.com/liveinaus/Bemby" target="_blank" rel="noopener noreferrer">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          GitHub
        </a>
        <button class="logout-btn" @click="logout">{{ t('nav.logout') }}</button>
      </div>
    </nav>

    <main class="main">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { version as APP_VERSION } from '../package.json';
import { t, locale, setLocale } from './i18n';

const route = useRoute();
const router = useRouter();

const isPublicRoute = computed(() => route.meta.public === true);
const sidebarOpen = ref(false);

function logout() {
  localStorage.removeItem('token');
  router.push('/login');
}
</script>
