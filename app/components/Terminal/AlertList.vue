<script setup lang="ts">
// The alert feed. Each alert names the rule that fired it, the change rows
// it cites (expandable, so the claim can be checked against the row), and
// the source those rows were read from.

import { relativeStamp } from '#shared/utils/terminal-format'
import type { AlertView, ChangeView } from '#shared/utils/terminal-types'

const props = withDefaults(
  defineProps<{
    alerts: AlertView[]
    /** Heading level for each alert's headline — 3 inside a panel, 2 on /alerts. */
    level?: 2 | 3
  }>(),
  { level: 3 },
)

const now = useNow()
const headingTag = computed(() => `h${props.level}`)

const RULE_TEXT: Record<AlertView['rule'], string> = {
  's1-floor':
    'Deterministic floor rule: a new S-1/424B4 filing on a whitelisted CIK always alerts — no model in the loop.',
  'agent-judge':
    'Agent-judged significance. The explanation may cite only fields present in the referenced change rows; nothing outside them.',
}

const SEVERITY = {
  critical: { color: 'error', icon: 'i-lucide-siren' },
  notable: { color: 'warning', icon: 'i-lucide-triangle-alert' },
  info: { color: 'info', icon: 'i-lucide-info' },
} as const

const CHANGE = {
  added: { color: 'success', icon: 'i-lucide-plus' },
  removed: { color: 'neutral', icon: 'i-lucide-minus' },
  modified: { color: 'warning', icon: 'i-lucide-pencil' },
} as const

function changeLabel(change: ChangeView): string {
  return `${change.change_type} ${change.entity_type}`
}
</script>

<template>
  <ol class="divide-y divide-default">
    <li v-for="alert in alerts" :id="alert.id" :key="alert.id" class="space-y-2 py-4 first:pt-0">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <UBadge
          :color="SEVERITY[alert.severity].color"
          :icon="SEVERITY[alert.severity].icon"
          variant="subtle"
          size="sm"
        >
          {{ alert.severity }}
        </UBadge>
        <TerminalCaveatMark :label="alert.rule" :text="RULE_TEXT[alert.rule]" />
        <time :datetime="alert.created_at" :title="alert.created_at" class="ml-auto text-toned">
          {{ relativeStamp(alert.created_at, now) }}
        </time>
      </div>

      <component :is="headingTag" class="text-lg text-highlighted">{{ alert.headline }}</component>
      <p class="text-sm text-default">{{ alert.explanation }}</p>

      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <TerminalProvenanceTag :source-url="alert.source_url" :fetched-at="alert.fetched_at" />
        <span v-if="alert.missing_change_ids.length" class="text-xs text-toned">
          {{ alert.missing_change_ids.length }} cited change id(s) not found in the change log
        </span>
      </div>

      <UCollapsible v-if="alert.changes.length" class="space-y-2">
        <UButton
          variant="link"
          color="neutral"
          size="sm"
          trailing-icon="i-lucide-chevron-down"
          class="px-0 text-toned"
          :label="`${alert.changes.length} cited change row${alert.changes.length === 1 ? '' : 's'}`"
        />
        <template #content>
          <ul class="space-y-3 rounded border border-default bg-muted p-3">
            <li v-for="change in alert.changes" :key="change.id" class="space-y-1 text-sm">
              <div class="flex flex-wrap items-center gap-2">
                <UBadge
                  :color="CHANGE[change.change_type].color"
                  :icon="CHANGE[change.change_type].icon"
                  variant="subtle"
                  size="sm"
                >
                  {{ changeLabel(change) }}
                </UBadge>
                <span class="text-default">{{ change.summary }}</span>
              </div>
              <dl
                v-if="change.diff.length"
                class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"
              >
                <template v-for="d in change.diff" :key="d.field">
                  <dt class="font-mono text-toned">{{ d.field }}</dt>
                  <dd class="font-mono text-default">
                    <span class="line-through decoration-1 text-toned">{{ d.before ?? '∅' }}</span>
                    →
                    <span>{{ d.after ?? '∅' }}</span>
                  </dd>
                </template>
              </dl>
              <div class="flex flex-wrap items-baseline gap-x-3 text-xs text-toned">
                <span class="font-mono">{{ change.entity_key }}</span>
                <span
                  >detected
                  <time :datetime="change.detected_at">{{ change.detected_at }}</time></span
                >
                <TerminalProvenanceTag
                  :source-url="change.source_url"
                  :fetched-at="change.fetched_at"
                />
              </div>
            </li>
          </ul>
        </template>
      </UCollapsible>
    </li>
  </ol>
</template>
