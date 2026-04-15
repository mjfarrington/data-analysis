import axios from 'axios'

const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const msg = err.response?.data?.detail || err.message || 'Unknown error'
    return Promise.reject(new Error(msg))
  },
)

export default api

// ─── Types ────────────────────────────────────────────────────────────────────
export type SourceType = 'grpc' | 'jdbc' | 'json' | 'csv'

export interface ExtractConfig {
  // Source selector
  source_type: SourceType

  // gRPC
  application_ids: string[]

  // Date range (all sources)
  dates: string[]
  date_from?: string
  date_to?: string

  // Segmentation
  rows_per_segment: number   // rows per output file (jdbc/json/csv)
  page_size: number          // gRPC batch fetch size

  output_format: 'parquet' | 'csv'

  // JDBC
  jdbc_url?: string
  jdbc_sql_file_id?: number
  jdbc_sql?: string
  jdbc_table?: string
  jdbc_date_column?: string

  // File (json / csv)
  file_path?: string
  file_encoding?: string
  csv_delimiter?: string
  csv_has_header?: boolean
  json_lines?: boolean
}

export interface TransformConfig {
  filters: Record<string, string>
  drop_columns: string[]
  rename_columns: Record<string, string>
  dedup: boolean
  dedup_keys: string[]
}

export interface LoadConfig {
  target: 'parquet' | 'csv' | 'spark_table'
  table_name?: string
  use_namespace: boolean
  namespace_db?: string   // resolved at run time: the Spark database for this run
  partition_by: string[]
  mode: 'overwrite' | 'append'
}

export interface ExecutionContext {
  id: number
  business_date: string | null
  namespace_prefix: string
  namespace: string | null  // resolved: prefix + compact date
  updated_at: string
}

export interface RunTrigger {
  extract_config?: Partial<ExtractConfig>
  business_date?: string
  namespace_prefix?: string
  use_namespace?: boolean
}

export interface Pipeline {
  id: number
  name: string
  description?: string
  status: 'active' | 'inactive' | 'draft'
  extract_config: ExtractConfig
  transform_config: TransformConfig
  load_config: LoadConfig
  schedule?: string
  schedule_enabled: boolean
  created_at: string
  updated_at: string
  last_run?: RunSummary
  total_runs: number
}

export interface RunSummary {
  id: number
  pipeline_id: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  triggered_by: string
  started_at?: string
  finished_at?: string
  duration_seconds?: number
  records_extracted: number
  records_loaded: number
  segments_processed: number
  error_message?: string
  created_at: string
}

export interface RunLog {
  id: number
  level: string
  message: string
  step?: string
  timestamp: string
  extra?: Record<string, unknown>
}

export interface RunDetail extends RunSummary {
  records_transformed: number
  run_metadata?: Record<string, unknown>
  logs: RunLog[]
  extract_jobs: ExtractJob[]
}

export interface ExtractJob {
  id: number
  application_id: string
  date: string
  segment: number
  total_segments?: number
  status: string
  records_count: number
  output_path?: string
  output_format: string
  started_at?: string
  finished_at?: string
  error_message?: string
}

export interface ServiceInfo {
  name: string
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  url?: string
  message?: string
  latency_ms?: number
  details?: Record<string, unknown>
}

export interface ServicesStatus {
  overall: string
  services: ServiceInfo[]
  checked_at: string
}

export interface SparkTestItem {
  name: string
  status: 'passed' | 'failed' | 'skipped'
  duration_ms: number
  detail?: string
}

export interface SparkTestResult {
  overall: 'passed' | 'failed'
  tests: SparkTestItem[]
  total_ms: number
  spark_version?: string
  catalog_tables?: number
}

export interface DataTable {
  name: string
  path: string
  format: string
  size_bytes: number
  row_count?: number
  columns: string[]
  partitions: string[]
  last_modified?: string
  file_count?: number
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  row_count: number
  truncated: boolean
  duration_ms: number
}

export interface CatalogTable {
  database: string
  name: string
  is_temporary: boolean
}

export interface ErrorRecord {
  id: number
  service: string
  level: string
  message: string
  traceback?: string
  context?: Record<string, unknown>
  resolved: boolean
  timestamp: string
}

// ─── API helpers ─────────────────────────────────────────────────────────────
export const pipelinesApi = {
  list: (status?: string) => api.get<Pipeline[]>('/etl/pipelines', { params: { status } }),
  get: (id: number) => api.get<Pipeline>(`/etl/pipelines/${id}`),
  create: (data: Partial<Pipeline>) => api.post<Pipeline>('/etl/pipelines', data),
  update: (id: number, data: Partial<Pipeline>) => api.put<Pipeline>(`/etl/pipelines/${id}`, data),
  delete: (id: number) => api.delete(`/etl/pipelines/${id}`),
  run: (id: number, trigger?: RunTrigger) =>
    api.post<RunSummary>(`/etl/pipelines/${id}/run`, trigger ?? {}),
  getContext: () => api.get<ExecutionContext>('/etl/context'),
  updateContext: (data: { business_date?: string | null; namespace_prefix?: string }) =>
    api.put<ExecutionContext>('/etl/context', data),
  runs: (id: number, limit?: number) =>
    api.get<RunSummary[]>(`/etl/pipelines/${id}/runs`, { params: { limit } }),
}

export const runsApi = {
  list: (status?: string, limit?: number) =>
    api.get<RunSummary[]>('/etl/runs', { params: { status, limit } }),
  get: (id: number) => api.get<RunDetail>(`/etl/runs/${id}`),
  cancel: (id: number) => api.post(`/etl/runs/${id}/cancel`),
  active: () => api.get<number[]>('/etl/active'),
}

export const servicesApi = {
  status: () => api.get<ServicesStatus>('/services/status'),
  testSpark: () => api.post('/services/spark/test-connection'),
  runSparkTest: () => api.post<SparkTestResult>('/services/spark/run-test'),
  testGrpc: () => api.post('/services/grpc/test-connection'),
  grpcStatus: () => api.get('/services/grpc/status'),
}

export const dataApi = {
  tables: () => api.get<DataTable[]>('/data/tables'),
  catalog: () => api.get<CatalogTable[]>('/data/catalog'),
  dropTable: (db: string, table: string) =>
    api.delete(`/data/catalog/${encodeURIComponent(db)}/${encodeURIComponent(table)}`),
  dropDatabase: (db: string) =>
    api.delete(`/data/catalog/databases/${encodeURIComponent(db)}`),
  query: (sql: string, limit?: number, database?: string) =>
    api.post<QueryResult>('/data/query', { sql, limit: limit ?? 1000, database: database ?? null }),
  errors: (params?: { service?: string; resolved?: boolean; limit?: number }) =>
    api.get<ErrorRecord[]>('/data/errors', { params }),
  resolveError: (id: number) => api.patch<ErrorRecord>(`/data/errors/${id}/resolve`),
  sources: (appId?: string) =>
    api.get('/etl/sources/available', { params: { application_id: appId } }),
}

// ─── SQL Files ────────────────────────────────────────────────────────────────
export interface SqlFile {
  id: number
  name: string
  description?: string
  content: string
  created_at: string
  updated_at: string
}

export const sqlFilesApi = {
  list: () => api.get<SqlFile[]>('/etl/sql-files'),
  get: (id: number) => api.get<SqlFile>(`/etl/sql-files/${id}`),
  create: (data: Omit<SqlFile, 'id' | 'created_at' | 'updated_at'>) =>
    api.post<SqlFile>('/etl/sql-files', data),
  update: (id: number, data: Partial<Omit<SqlFile, 'id' | 'created_at' | 'updated_at'>>) =>
    api.put<SqlFile>(`/etl/sql-files/${id}`, data),
  delete: (id: number) => api.delete(`/etl/sql-files/${id}`),
}

// ─── Pipeline Graph / Dependencies ───────────────────────────────────────────
export interface GraphNode {
  id: number
  name: string
  description?: string
  status: string
  source_type: string
  last_run_status?: string
}

export interface GraphEdge {
  id: string
  source: number
  target: number
  dependency_id: number
}

export interface PipelineGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface Dependency {
  id: number
  pipeline_id: number
  upstream_id: number
  created_at: string
}

export const graphApi = {
  graph: () => api.get<PipelineGraph>('/etl/graph'),
  listDeps: (pid: number) => api.get<Dependency[]>(`/etl/pipelines/${pid}/dependencies`),
  addDep: (pid: number, upstream_id: number) =>
    api.post<Dependency>(`/etl/pipelines/${pid}/dependencies`, { upstream_id }),
  removeDep: (pid: number, dep_id: number) =>
    api.delete(`/etl/pipelines/${pid}/dependencies/${dep_id}`),
}
