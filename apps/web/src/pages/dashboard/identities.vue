<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import { useLoading } from '../../composables/useLoading.ts';

interface IdentityRow {
  userId: number;
  providerId: string;
  subject: string;
  email: string | null;
  linkedAt: string;
}

const api = useApi();

const identities = ref<IdentityRow[]>([]);
const providers = ref<Array<{ id: string; displayName: string }>>([]);
const errorMessage = ref<string | null>(null);
const toast = ref<string | null>(null);

const showToast = (msg: string) => {
  toast.value = msg;
  window.setTimeout(() => { toast.value = null; }, 3500);
};

const refresh = async () => {
  const [ident, provs] = await Promise.all([
    callApi<{ identities: IdentityRow[] }>(() => api.api.users.me.identities.$get()),
    callApi<{ providers: Array<{ id: string; displayName: string }> }>(() => api.auth.oauth.providers.$get()),
  ]);
  if (ident.data) identities.value = ident.data.identities;
  if (provs.data) providers.value = provs.data.providers;
};

onMounted(refresh);

const [linkLoading, startLink] = useLoading(async (providerId: string) => {
  errorMessage.value = null;
  const { data, error } = await callApi<{ url: string }>(
    () => api.auth.oauth[':provider']['authorize-url'].$post({ param: { provider: providerId }, json: { intent: 'link', returnTo: '/dashboard/identities' } }),
  );
  if (error) {
    errorMessage.value = error.message;
    return;
  }
  if (data) window.location.assign(data.url);
});

const [unlinkLoading, unlink] = useLoading(async (row: IdentityRow) => {
  errorMessage.value = null;
  const { error } = await callApi(
    () => api.api.users.me.identities[':providerId'][':subject'].unlink.$post({ param: { providerId: row.providerId, subject: row.subject } }),
  );
  if (error) {
    errorMessage.value = error.message;
    return;
  }
  showToast(`Unlinked ${row.providerId}`);
  await refresh();
});

const displayName = (providerId: string): string => providers.value.find(p => p.id === providerId)?.displayName ?? providerId;
</script>

<template>
  <div class="space-y-6">
    <div>
      <h2 class="text-lg font-semibold text-white">Linked identities</h2>
      <p class="mt-1 text-sm text-gray-500">External accounts that can sign in as you.</p>
    </div>

    <div v-if="toast" class="rounded-lg border border-accent-emerald/40 bg-accent-emerald/10 p-3 text-sm text-accent-emerald">
      {{ toast }}
    </div>
    <div v-if="errorMessage" class="rounded-lg border border-accent-rose/20 bg-accent-rose/10 p-3 text-sm text-accent-rose">
      {{ errorMessage }}
    </div>

    <div class="glass-card p-6">
      <div v-if="identities.length === 0" class="text-sm text-gray-500">No identities linked yet.</div>
      <ul v-else class="divide-y divide-white/[0.05]">
        <li v-for="row in identities" :key="`${row.providerId}:${row.subject}`" class="flex items-center justify-between py-3">
          <div>
            <div class="text-sm font-medium text-white">{{ displayName(row.providerId) }}</div>
            <div class="text-xs text-gray-500">
              subject: {{ row.subject }}<span v-if="row.email"> · {{ row.email }}</span>
            </div>
          </div>
          <button type="button" class="btn-danger" :disabled="unlinkLoading" @click="unlink(row)">
            Unlink
          </button>
        </li>
      </ul>
    </div>

    <div v-if="providers.length > 0" class="glass-card p-6">
      <h3 class="mb-3 text-sm font-medium uppercase tracking-widest text-gray-400">Link a new identity</h3>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="provider in providers"
          :key="provider.id"
          type="button"
          class="btn-ghost"
          :disabled="linkLoading"
          @click="startLink(provider.id)"
        >
          Link {{ provider.displayName }}
        </button>
      </div>
    </div>
  </div>
</template>
