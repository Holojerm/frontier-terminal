<script setup lang="ts">
// The digest signup's one line in a page header. The form itself sits after the page's
// data, so it doesn't push the content down or outrank it.

const enabled = useSubscribeEnabled()
</script>

<template>
  <p v-if="enabled" class="text-sm text-muted print:hidden">
    <a href="#digest" class="text-primary underline underline-offset-2"
      >Get the weekly thesis digest</a
    >
    by email, each Monday.
  </p>
</template>
