<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { callApi, useApi } from '../../api/client.ts';
import { type AuthUser, useAuthStore } from '../../stores/auth.ts';

definePage({ meta: { public: true } });

const router = useRouter();
const auth = useAuthStore();
const api = useApi();

const message = ref('Completing sign-in...');

onMounted(async () => {
  const fragment = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  const params = new URLSearchParams(fragment);
  const session = params.get('session');
  const returnTo = params.get('return_to');
  if (!session) {
    await router.replace('/login?error=handoff-failed');
    return;
  }
  auth.setAuth({ token: session, user: { id: -1, username: '', isAdmin: false, canViewGlobalTelemetry: false, upstreamIds: null } });
  const { data, error } = await callApi<{ user: AuthUser }>(() => api.auth.me.$get());
  if (error || !data) {
    auth.clearAuth();
    await router.replace('/login?error=handoff-failed');
    return;
  }
  auth.setUser(data.user);
  const safe = returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/dashboard';
  await router.replace(safe);
  message.value = 'Redirecting...';
});
</script>

<template>
  <main class="flex min-h-screen items-center justify-center p-4">
    <div class="glass-card p-8 text-center text-sm text-gray-400">{{ message }}</div>
  </main>
</template>
