<script setup lang="ts">
// Where the emailed confirmation link lands. It posts the token on load, so one
// click confirms, and a mail scanner that only fetches the page confirms nobody.

useSeo({
  title: 'Confirm your subscription',
  description: 'Confirm your email address to start the weekly thesis digest.',
  noindex: true,
})

const token = String(useRoute().query.t ?? '')
const state = ref<'working' | 'done' | 'failed'>('working')

onMounted(async () => {
  try {
    await $fetch('/api/subscribe/confirm', { method: 'POST', body: { token } })
    state.value = 'done'
  } catch {
    state.value = 'failed'
  }
})
</script>

<template>
  <TerminalPage title="Confirm your subscription" narrow>
    <p v-if="state === 'working'" role="status" class="text-sm text-muted">Confirming…</p>
    <UAlert
      v-else-if="state === 'done'"
      role="status"
      color="success"
      variant="soft"
      icon="i-lucide-check"
      title="You’re subscribed."
      description="The digest arrives each Monday. Every email has an unsubscribe link."
    />
    <UAlert
      v-else
      role="alert"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      title="That link didn’t work."
      description="It may have expired (they last a week) or already been used. Subscribe again from any theses page for a fresh one."
    />
    <p class="text-sm">
      <NuxtLink to="/theses" class="text-primary underline underline-offset-2"
        >Open the theses</NuxtLink
      >
    </p>
  </TerminalPage>
</template>
