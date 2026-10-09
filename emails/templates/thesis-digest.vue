<!-- Data: summary, generated, thesesUrl, quiet, theses[]. Each thesis carries a name,
     its statement, and claims[]; each claim exactly one of bad/warn/good/idle (its
     status as a tone), n, text, status, reason, and optional moved (the status it
     left this week) and week (its reading a week ago and now). Each thesis also
     carries verdicts[] (rated this week) and awaiting[] (material, unconfirmed).

     The tone is four copies of the bar, selected at runtime, because a color has to
     be inlined at build time and the status is only known at runtime. -->
<template>
  <EmailLayout wide title="{{appName}} theses" kicker="Weekly thesis digest" heading="{{summary}}">
    <Raw>{{#quiet}}</Raw>
    <EmailParagraph>No claim changed status and nothing was rated this week.</EmailParagraph>
    <Raw>{{/quiet}}</Raw>
    <Raw>{{#theses}}</Raw>
    <p class="m-0 mb-1 text-[17px] font-semibold text-ink"><Raw>{{name}}</Raw></p>
    <p class="m-0 mb-4 text-sm leading-normal text-muted"><Raw>{{statement}}</Raw></p>
    <Raw>{{#claims}}</Raw>
    <table role="presentation" class="mb-4 w-full">
      <tr>
        <Raw>{{#bad}}</Raw><td class="w-[3px] bg-bad"></td><Raw>{{/bad}}</Raw>
        <Raw>{{#warn}}</Raw><td class="w-[3px] bg-warn"></td><Raw>{{/warn}}</Raw>
        <Raw>{{#good}}</Raw><td class="w-[3px] bg-good"></td><Raw>{{/good}}</Raw>
        <Raw>{{#idle}}</Raw><td class="w-[3px] bg-rule"></td><Raw>{{/idle}}</Raw>
        <td class="pl-3">
          <p class="m-0 mb-1 text-[15px] font-semibold text-ink">
            <Raw>{{n}}</Raw>. <Raw>{{text}}</Raw>
            <span class="ml-1.5 font-mono text-xs font-normal text-muted"><Raw>{{status}}</Raw><Raw>{{#moved}}</Raw> (was <Raw>{{moved}}</Raw>)<Raw>{{/moved}}</Raw></span>
          </p>
          <div class="text-sm leading-normal text-copy [word-break:break-word]"><Raw>{{reason}}</Raw></div>
          <Raw>{{#week}}</Raw>
          <div class="pt-1 font-mono text-xs text-muted">Week: <Raw>{{week}}</Raw></div>
          <Raw>{{/week}}</Raw>
        </td>
      </tr>
    </table>
    <Raw>{{/claims}}</Raw>
    <Raw>{{#verdicts.length}}</Raw>
    <p class="m-0 mb-1 mt-2 text-[15px] font-semibold text-ink">Rated this week</p>
    <Raw>{{/verdicts.length}}</Raw>
    <Raw>{{#verdicts}}</Raw>
    <div class="border-0 border-t border-solid border-rule py-2">
      <div class="font-mono text-xs text-muted">Claim <Raw>{{n}}</Raw> &middot; <Raw>{{provider}}</Raw> &middot; <Raw>{{verdict}}</Raw> &middot; <a href="{{url}}" class="text-copy"><Raw>{{event}}</Raw></a></div>
      <div class="text-sm leading-normal text-copy [word-break:break-word]"><Raw>{{rationale}}</Raw></div>
    </div>
    <Raw>{{/verdicts}}</Raw>
    <Raw>{{#awaiting.length}}</Raw>
    <p class="m-0 mb-1 mt-4 text-[15px] font-semibold text-ink">Awaiting your confirmation</p>
    <Raw>{{/awaiting.length}}</Raw>
    <Raw>{{#awaiting}}</Raw>
    <div class="py-1 text-sm leading-normal text-copy [word-break:break-word]">Claim <Raw>{{n}}</Raw>: <Raw>{{event}}</Raw> <span class="font-mono text-xs text-muted"><Raw>{{subject}}</Raw></span></div>
    <Raw>{{/awaiting}}</Raw>
    <Raw>{{/theses}}</Raw>
    <table role="presentation" class="mb-2 mt-4">
      <tr>
        <td><EmailButton href="{{thesesUrl}}" tone="ink" compact>Open the theses</EmailButton></td>
      </tr>
    </table>
    <template #footnote>
      Sent every Monday by the theses:digest cron. Confirm or reject a material event by adding it
      to the claim's confirmations in server/theses/. Generated <Raw>{{generated}}</Raw>.
    </template>
  </EmailLayout>
</template>
