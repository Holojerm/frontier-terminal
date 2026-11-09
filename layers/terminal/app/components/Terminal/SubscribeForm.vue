<script setup lang="ts">
// The weekly thesis digest signup: one field, one button, and a line saying
// what arrives and how often. Renders nothing until the Worker has a mail
// provider (useSubscribeEnabled). The answer is the same for a new and a known
// address, so the sent state never says which it was.

const enabled = useSubscribeEnabled()
const route = useRoute()

const email = ref('')
// Honeypot: hidden from people, filled by form-scraping bots.
const website = ref('')
const status = ref<'idle' | 'sending' | 'sent' | 'error'>('idle')
const message = ref('')

async function submit() {
  if (status.value === 'sending') return
  status.value = 'sending'
  try {
    await $fetch('/api/subscribe', {
      method: 'POST',
      body: { email: email.value, from: route.path, website: website.value },
    })
    status.value = 'sent'
  } catch (error) {
    const err = error as { statusCode?: number; data?: { data?: { message?: string } } }
    status.value = 'error'
    message.value =
      err.statusCode === 400
        ? (err.data?.data?.message ?? 'Enter a valid email address.')
        : err.statusCode === 429
          ? 'Too many tries. Wait a few minutes and try again.'
          : 'That didn’t go through. Try again in a minute.'
  }
}
</script>

<template>
  <section
    v-if="enabled"
    aria-labelledby="subscribe-heading"
    class="max-w-3xl space-y-2 rounded border border-default px-3 py-3 print:hidden"
  >
    <h2 id="subscribe-heading" class="text-sm text-highlighted">Get the weekly thesis digest</h2>
    <p class="text-xs text-muted">
      One email each Monday: where every claim stands and what moved. We use your address for
      nothing else.
      <NuxtLink to="/digest" external class="text-primary underline underline-offset-2"
        >See a sample</NuxtLink
      >
      ·
      <NuxtLink to="/about#privacy" class="text-primary underline underline-offset-2"
        >Privacy</NuxtLink
      >
    </p>

    <p v-if="status === 'sent'" role="status" class="text-sm text-default">
      Check your inbox. If the address can receive mail, a confirmation link is on its way, and the
      digest starts once you click it.
    </p>
    <form v-else class="space-y-2" novalidate @submit.prevent="submit">
      <div class="flex flex-wrap items-start gap-2">
        <UInput
          v-model="email"
          type="email"
          name="email"
          autocomplete="email"
          inputmode="email"
          placeholder="you@example.com"
          aria-label="Email address"
          :aria-invalid="status === 'error' ? 'true' : undefined"
          aria-describedby="subscribe-status"
          size="sm"
          class="w-full min-w-0 sm:w-72"
          required
        />
        <UButton
          type="submit"
          size="sm"
          :loading="status === 'sending'"
          :disabled="status === 'sending'"
          label="Subscribe"
        />
      </div>
      <div aria-hidden="true" class="sr-only">
        <label>
          Leave this empty
          <input v-model="website" type="text" name="website" tabindex="-1" autocomplete="off" />
        </label>
      </div>
      <p id="subscribe-status" role="status" class="min-h-4 text-xs text-error">
        <template v-if="status === 'error'">{{ message }}</template>
      </p>
    </form>
  </section>
</template>
