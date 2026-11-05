// HEAD /export/bulk/<recent|full>/<table>.<csv.gz|parquet> — the GET route's
// headers (size, ETag, license) with no body. DuckDB and pyarrow send it
// before reading a Parquet file by range. Same key rule and rate limit.

export { default } from './[file].get'
