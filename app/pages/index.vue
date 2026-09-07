<script setup lang="ts">
// Placeholder landing page. The terminal UI replaces this in a later PR; what
// has to survive that replacement is the contract below — one useSeo() call
// and a publicPage declaration, which is what puts this URL in sitemap.xml
// and llms.txt (scripts/check-seo.ts fails the build otherwise).

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '1.0',
    title: 'Overview',
    summary:
      'What the terminal tracks across the frontier AI labs — API pricing, hiring, SEC filings — and where each number comes from.',
  },
})

const config = useRuntimeConfig()

// One source for the site's one-sentence claim — also used by /llms.txt and
// the schema.org description, so all three agree.
const description = config.public.appDescription

useSeo({
  // 'exact' because the brand should lead on the landing page — everywhere else
  // useSeo appends `· AppName` for you.
  titleMode: 'exact',
  title: config.public.appName,
  description,
})
</script>

<template>
  <section class="mx-auto flex max-w-2xl flex-col gap-6 py-16 text-center">
    <h1 class="text-4xl text-highlighted sm:text-5xl">{{ config.public.appName }}</h1>
    <p class="text-lg text-muted">{{ description }}</p>
    <p class="text-sm text-dimmed">Not investment advice.</p>
  </section>
</template>
