<!-- Data: confirmUrl. The double opt-in mail: nothing is sent to the address
     until the link is followed. -->
<template>
  <EmailLayout title="Confirm your subscription" kicker="Weekly thesis digest" heading="Confirm your subscription">
    <EmailParagraph>
      Someone asked for the <Raw>{{appName}}</Raw> weekly thesis digest to be sent to this address. If that was you, confirm below. It's one email each Monday.
    </EmailParagraph>
    <EmailButton href="{{confirmUrl}}">Confirm subscription</EmailButton>
    <template #footnote>
      If you didn't ask for this, ignore this email. We won't write again, and the link stops working in a week.
    </template>
  </EmailLayout>
</template>
