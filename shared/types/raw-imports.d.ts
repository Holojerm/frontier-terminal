// Nitro's rollup `raw` plugin serves `import text from 'raw:<path>'` as the
// file's UTF-8 contents. The pipeline tasks read sources.yaml this way, since
// a Worker has no filesystem. (Vite spells the same thing `<path>?raw`, which
// the workerd test suite uses; Nitro does not accept that suffix.)
declare module 'raw:*' {
  const text: string
  export default text
}
