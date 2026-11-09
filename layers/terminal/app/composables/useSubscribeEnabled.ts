// Whether the subscribe form should render. Set on the server from the Worker's
// config (plugins/subscribe.server.ts) and read everywhere else, so a Worker
// without the Resend key renders no form and no sample link.
export const useSubscribeEnabled = () => useState<boolean>('subscribe-enabled', () => false)
