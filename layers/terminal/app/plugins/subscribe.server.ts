// Server-side only: the Resend key is a private runtime value and never
// reaches the browser. All the client gets is the boolean it implies.
export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig() as { resendApiKey?: string; subscribeEmailFrom?: string }
  useSubscribeEnabled().value = Boolean(config.resendApiKey && config.subscribeEmailFrom)
})
