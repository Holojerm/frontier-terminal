<script setup lang="ts">
// Where the unsubscribe link in each digest lands. It posts the token on load,
// so one click is enough, and a link scanner that only fetches the page changes
// nothing.

useSeo({
  title: 'Unsubscribe',
  description: 'Stop the weekly thesis digest.',
  noindex: true,
})

const token = String(useRoute().query.u ?? '')
const state = ref<'working' | 'done' | 'failed'>('working')

onMounted(async () => {
  try {
    await $fetch('/api/subscribe/unsubscribe', { method: 'POST', body: { token } })
    state.value = 'done'
  } catch {
    state.value = 'failed'
  }
})
</script>

<template>
  <TerminalPage title="Unsubscribe" narrow>
    <p v-if="state === 'working'" role="status" class="text-sm text-muted">Unsubscribing…</p>
    <UAlert
      v-else-if="state === 'done'"
      role="status"
      color="success"
      variant="soft"
      icon="i-lucide-check"
      title="You’re unsubscribed."
      description="No more digests. We keep the address, marked as unsubscribed, so it isn’t added again by mistake. Write to contact@frontierterm.com to have it deleted."
    />
    <UAlert
      v-else
      role="alert"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      title="That link didn’t work."
      description="Use the link in the newest digest, or write to contact@frontierterm.com and we’ll remove you."
    />
  </TerminalPage>
</template>
