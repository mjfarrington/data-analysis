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
  jdbc_application_ids?: string[]  // injected as $app_id into the SQL template

  // SQL variable injection (JDBC)
  jdbc_date_var_format?: string     // YYYYMMDD | YYYY-MM-DD | YYYYMM | YYYY/MM/DD | DD/MM/YYYY | MM/DD/YYYY
  jdbc_date_range_mode?: string     // single | current_month | previous_month | custom
  jdbc_date_range_from?: string     // YYYY-MM-DD (custom range start)
  jdbc_date_range_to?: string       // YYYY-MM-DD (custom range end)

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
  namespace_db?: string   // resolved at run time from business_date
  partition_by: string[]
  mode: 'overwrite' | 'append'
}

export interface ExecutionContext {
  id: number
  business_date: string | null
  namespace_prefix: string
  db_name: string | null  // direct Spark database name override
  namespace: string | null  // resolved: db_name if set, else prefix + compact date
  updated_at: string
}

export interface RunTrigger {
  extract_config?: Partial<ExtractConfig>
  business_date?: string
}

export interface Pipeline {
  id: number
  name: string
  description?: string
  tags: string[]
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
  delete: (id: number) => api.delete(`/etl/runs/${id}`),
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
  deleteFileTable: (name: string) => api.delete(`/data/tables/${encodeURIComponent(name)}`),
  catalog: () => api.get<CatalogTable[]>('/data/catalog'),
  databases: () => api.get<string[]>('/data/catalog/databases'),
  dropTable: (db: string, table: string) =>
    api.delete(`/data/catalog/${encodeURIComponent(db)}/${encodeURIComponent(table)}`),
  dropDatabase: (db: string) =>
    api.delete(`/data/catalog/databases/${encodeURIComponent(db)}`),
  clearDatabaseTables: (db: string) =>
    api.delete<{ dropped: number }>(`/data/catalog/${encodeURIComponent(db)}/tables`),
  query: (sql: string, limit?: number, offset?: number, database?: string) =>
    api.post<QueryResult>('/data/query', { sql, limit: limit ?? 500, offset: offset ?? 0, database: database ?? null }),
  errors: (params?: { service?: string; resolved?: boolean; limit?: number }) =>
    api.get<ErrorRecord[]>('/data/errors', { params }),
  resolveError: (id: number) => api.patch<ErrorRecord>(`/data/errors/${id}/resolve`),
  sources: (appId?: string) =>
    api.get('/etl/sources/available', { params: { application_id: appId } }),
}

// ─── SQL Files ────────────────────────────────────────────────────────────────
export type SqlFileType = 'extract' | 'transform'

export const SQL_VERSION_TAGS = ['DRAFT', 'REVIEW', 'FINAL', 'DEPRECATED'] as const
export type SqlVersionTag = typeof SQL_VERSION_TAGS[number] | string

export interface SqlFileVersion {
  id: number
  sql_file_id: number
  version: string       // e.g. "v0.1.0"
  tag: SqlVersionTag    // e.g. "DRAFT" | "FINAL"
  content: string
  created_at: string
}

export interface SqlFile {
  id: number
  name: string
  description?: string
  file_type: SqlFileType
  content: string
  versions: SqlFileVersion[]
  created_at: string
  updated_at: string
}

export const sqlFilesApi = {
  list: (file_type?: SqlFileType) =>
    api.get<SqlFile[]>('/etl/sql-files', { params: file_type ? { file_type } : {} }),
  get: (id: number) => api.get<SqlFile>(`/etl/sql-files/${id}`),
  create: (data: { name: string; description?: string; file_type: SqlFileType; content: string }) =>
    api.post<SqlFile>('/etl/sql-files', data),
  update: (id: number, data: Partial<{ name: string; description: string; file_type: SqlFileType; content: string }>) =>
    api.put<SqlFile>(`/etl/sql-files/${id}`, data),
  delete: (id: number) => api.delete(`/etl/sql-files/${id}`),
  // Versions
  listVersions: (id: number) => api.get<SqlFileVersion[]>(`/etl/sql-files/${id}/versions`),
  createVersion: (id: number, tag?: string) =>
    api.post<SqlFileVersion>(`/etl/sql-files/${id}/versions`, { tag: tag ?? 'DRAFT' }),
  updateVersionTag: (id: number, vid: number, tag: string) =>
    api.patch<SqlFileVersion>(`/etl/sql-files/${id}/versions/${vid}/tag`, { tag }),
  // SQL variable preview
  previewSql: (req: SqlPreviewRequest) =>
    api.post<SqlPreviewResponse>('/etl/sql/preview', req),
}

export interface SqlPreviewRequest {
  sql?: string
  sql_file_id?: number
  date_var_format?: string
  date_range_mode?: string     // single | current_month | previous_month | custom
  date_range_from?: string     // YYYY-MM-DD
  date_range_to?: string       // YYYY-MM-DD
}

export interface SqlPreviewResponse {
  resolved_sql: string
  variables: Record<string, string>
  business_date: string | null
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

// ─── Notebook Files ───────────────────────────────────────────────────────────
export interface NotebookCell {
  type: 'code' | 'markdown'
  source: string
}

export interface NotebookFile {
  id: number
  name: string
  description?: string
  cells: NotebookCell[]
  created_at: string
  updated_at: string
}

export const notebookFilesApi = {
  list: () => api.get<NotebookFile[]>('/transform/notebooks'),
  get: (id: number) => api.get<NotebookFile>(`/transform/notebooks/${id}`),
  create: (data: Omit<NotebookFile, 'id' | 'created_at' | 'updated_at'>) =>
    api.post<NotebookFile>('/transform/notebooks', data),
  update: (id: number, data: Partial<Omit<NotebookFile, 'id' | 'created_at' | 'updated_at'>>) =>
    api.put<NotebookFile>(`/transform/notebooks/${id}`, data),
  delete: (id: number) => api.delete(`/transform/notebooks/${id}`),
}

// ─── Transform Jobs ───────────────────────────────────────────────────────────
export type TransformJobStatus = 'idle' | 'running' | 'completed' | 'failed'
export type TransformType = 'sql' | 'notebook'
export type WriteMode = 'overwrite' | 'append'

export interface TransformJob {
  id: number
  name: string
  description?: string
  tags: string[]
  source_database?: string
  source_table: string
  transform_type: TransformType
  sql_content?: string
  sql_file_id?: number
  sql_file_name?: string
  notebook_file_id?: number
  notebook_file_name?: string
  target_database?: string
  target_table: string
  target_mode: WriteMode
  status: TransformJobStatus
  last_run_at?: string
  last_run_duration_s?: number
  last_run_rows?: number
  last_error?: string
  created_at: string
  updated_at: string
}

export const transformJobsApi = {
  list: () => api.get<TransformJob[]>('/transform/jobs'),
  get: (id: number) => api.get<TransformJob>(`/transform/jobs/${id}`),
  create: (data: Omit<TransformJob, 'id' | 'status' | 'last_run_at' | 'last_run_duration_s' | 'last_run_rows' | 'last_error' | 'created_at' | 'updated_at' | 'sql_file_name' | 'notebook_file_name'>) =>
    api.post<TransformJob>('/transform/jobs', data),
  update: (id: number, data: Partial<Omit<TransformJob, 'id' | 'status' | 'last_run_at' | 'last_run_duration_s' | 'last_run_rows' | 'last_error' | 'created_at' | 'updated_at' | 'sql_file_name' | 'notebook_file_name'>>) =>
    api.put<TransformJob>(`/transform/jobs/${id}`, data),
  delete: (id: number) => api.delete(`/transform/jobs/${id}`),
  run: (id: number) => api.post<TransformJob>(`/transform/jobs/${id}/run`),
  cancel: (id: number) => api.post<TransformJob>(`/transform/jobs/${id}/cancel`),
  preview: (data: {
    source_database?: string
    source_table: string
    transform_type: 'sql' | 'notebook'
    sql_content?: string
    cells?: NotebookCell[]
    limit?: number
  }) => api.post<{ columns: string[]; rows: unknown[][]; row_count: number; duration_ms: number }>('/transform/preview', data),
}

// ─── ETL Chains ───────────────────────────────────────────────────────────────
export type ChainStepType = 'pipeline' | 'transform'

export interface ChainStep {
  type: ChainStepType
  pipeline_id?: number
  transform_job_id?: number
  label?: string
}

export type ETLChainStatus = 'idle' | 'running' | 'completed' | 'failed'

export interface ETLChain {
  id: number
  name: string
  description?: string
  steps: ChainStep[]
  status: ETLChainStatus
  last_run_at?: string
  last_run_duration_s?: number
  last_error?: string
  created_at: string
  updated_at: string
}

export const chainsApi = {
  list: () => api.get<ETLChain[]>('/transform/chains'),
  get: (id: number) => api.get<ETLChain>(`/transform/chains/${id}`),
  create: (data: Pick<ETLChain, 'name' | 'description' | 'steps'>) =>
    api.post<ETLChain>('/transform/chains', data),
  update: (id: number, data: Partial<Pick<ETLChain, 'name' | 'description' | 'steps'>>) =>
    api.put<ETLChain>(`/transform/chains/${id}`, data),
  delete: (id: number) => api.delete(`/transform/chains/${id}`),
  run: (id: number) => api.post<ETLChain>(`/transform/chains/${id}/run`),
}

// ─── Connections ──────────────────────────────────────────────────────────────
export type ConnectionType = 'jdbc' | 'grpc' | 'rest' | 'other'

export interface Connection {
  id: number
  name: string
  description?: string
  conn_type: ConnectionType
  host?: string
  port?: number
  database?: string
  username?: string
  has_password: boolean
  extra?: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ConnectionPayload {
  name: string
  description?: string
  conn_type: ConnectionType
  host?: string
  port?: number
  database?: string
  username?: string
  password?: string   // plaintext — encrypted server-side
  extra?: Record<string, unknown>
}

export interface ConnectionTestResult {
  success: boolean
  message: string
  latency_ms?: number
}

export const connectionsApi = {
  list: () => api.get<Connection[]>('/connections'),
  get: (id: number) => api.get<Connection>(`/connections/${id}`),
  create: (data: ConnectionPayload) => api.post<Connection>('/connections', data),
  update: (id: number, data: Partial<ConnectionPayload>) => api.put<Connection>(`/connections/${id}`, data),
  delete: (id: number) => api.delete(`/connections/${id}`),
  test: (id: number) => api.post<ConnectionTestResult>(`/connections/${id}/test`),
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export interface StorageNode {
  path: string
  name: string
  size_bytes: number
  is_dir: boolean
  children: StorageNode[]
}

export interface StorageTree {
  nodes: StorageNode[]
  total_bytes: number
}

export interface AdminResult {
  ok: boolean
  message: string
  affected: number
}

export const adminApi = {
  storage: () => api.get<StorageTree>('/admin/storage'),
  purgePath: (path: string) => api.delete<AdminResult>('/admin/storage/path', { data: { path } }),
  purgeAll: () => api.delete<AdminResult>('/admin/storage/all'),
  deleteRuns: (ids?: number[]) =>
    api.delete<AdminResult>('/admin/runs', { data: { ids: ids ?? null } }),
  resetStats: () => api.post<AdminResult>('/admin/stats/reset'),
  clearErrors: () => api.post<AdminResult>('/admin/errors/clear'),
  restartService: (service: string) =>
    api.post<{ service: string; ok: boolean; message: string }>('/admin/services/restart', { service }),
}
