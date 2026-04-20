import axios from 'axios'

const api = axios.create({ baseURL: 'http://localhost:8000/api/v1' })

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RunSummary {
  id: number
  status: string
  started_at?: string
  finished_at?: string
  duration_seconds?: number
  records_extracted?: number
  records_loaded?: number
  segments_processed?: number
  error_message?: string
}

export interface Pipeline {
  id: number
  name: string
  description?: string
  status: 'active' | 'inactive' | 'draft'
  source_type: string
  load_target: string
  extract_config?: Record<string, unknown>
  transform_config?: Record<string, unknown>
  load_config?: Record<string, unknown>
  canvas_config?: { nodes: unknown[]; edges: unknown[]; viewport?: { x: number; y: number; zoom: number } }
  last_run?: RunSummary
}

export interface RunStep {
  id: number
  run_id: number
  step_order: number
  step_type: string
  step_label?: string
  parent_step_id?: number
  status: string
  started_at?: string
  finished_at?: string
  duration_seconds?: number
  records_in?: number
  records_out?: number
  error_message?: string
}

export interface RunLog {
  level: string
  message: string
  timestamp: string
  step?: string
}

export interface ExtractJob {
  id: number
  application_id?: string
  date?: string
  segment: number
  total_segments?: number
  status: string
  records_count?: number
  output_path?: string
}

export interface RunDetail extends RunSummary {
  pipeline_id: number
  logs: RunLog[]
  steps: RunStep[]
  extract_jobs: ExtractJob[]
}

export interface ChainStep {
  type: 'pipeline' | 'transform'
  pipeline_id?: number
  transform_job_id?: number
  label: string
}

export interface ETLChain {
  id: number
  name: string
  description?: string
  status?: string
  last_run_at?: string
  last_run_duration_s?: number
  last_error?: string
  steps: ChainStep[]
}

export interface TransformJob {
  id: number
  name: string
  description?: string
  tags: string[]
  source_database?: string
  source_table: string
  transform_type: 'sql' | 'notebook'
  sql_content?: string
  sql_file_id?: number
  sql_file_name?: string
  notebook_file_id?: number
  notebook_file_name?: string
  target_database?: string
  target_table: string
  target_mode: string
  status: string
  last_run_at?: string
  last_run_duration_s?: number
  last_run_rows?: number
  last_error?: string
  created_at: string
  updated_at: string
}

export interface NotebookCell {
  id: string
  type: 'code' | 'markdown'
  content: string
  language?: string  // explicit override; undefined = auto-detect
}

export interface NotebookFile {
  id: number
  name: string
  description?: string
  cells: NotebookCell[]
}

export interface DfPreview {
  columns: string[]
  rows: (string | null)[][]
  row_count: number
}

export interface CellOutput {
  cell_id: string
  stdout: string
  error: string | null
  df_preview: DfPreview | null
  execution_time_ms: number
}

export interface ExportConfig {
  target_db: string
  target_table: string
  source_var?: string
  mode?: string
}

export interface ExportResult {
  table: string
  row_count: number
  duration_s: number
}

export interface GraphNode {
  id: number
  name: string
  status: string
  source_type: string
  last_run_status?: string
  load_target: string
  last_run_step_statuses: Record<string, string>
}

export interface GraphEdge {
  from_pipeline_id: number
  to_pipeline_id: number
}

export interface ServiceInfo {
  name: string
  status: string
  url?: string
  message?: string
  latency_ms?: number
  details?: Record<string, unknown>
}

export interface ServicesStatus {
  overall: string
  services: ServiceInfo[]
  checked_at?: string
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

export interface DictionaryEntry {
  id: number
  key: string
  value: string
}

export interface Dictionary {
  id: number
  name: string
  description?: string
  key_label: string
  value_label: string
  entries: DictionaryEntry[]
}

export interface ForeachEntryResult {
  key: string
  value: string
  total_rows: number
  file_count: number
  output_dir: string
  error?: string
}

export interface SqlFile {
  id: number
  name: string
  description?: string
  file_type: string
  content: string
}

export interface DataTable {
  name: string
  columns: string[]
  row_count?: number
  size_bytes?: number
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  row_count?: number
  total_rows?: number
  truncated?: boolean
  duration_ms?: number
}

export interface CatalogTable {
  database: string
  name: string
  is_temporary: boolean
}

export interface ExecutionContext {
  business_date: string
  namespace: string
  namespace_prefix?: string
}

export interface Connection {
  id: number
  name: string
  description?: string
  conn_type: string   // datawarehouse | jdbc | grpc | rest | other
  host?: string
  port?: number
  database?: string
  username?: string
  extra: Record<string, unknown>
  created_at: string
  updated_at: string
}

// ── Pipelines API ─────────────────────────────────────────────────────────────

export const pipelinesApi = {
  list: () => api.get<Pipeline[]>('/etl/pipelines').then(r => r.data),
  get: (id: number) => api.get<Pipeline>(`/etl/pipelines/${id}`).then(r => r.data),
  create: (data: Partial<Pipeline>) =>
    api.post<Pipeline>('/etl/pipelines', data).then(r => r.data),
  update: (id: number, data: Partial<Pipeline>) =>
    api.put<Pipeline>(`/etl/pipelines/${id}`, data).then(r => r.data),
  delete: (id: number) => api.delete(`/etl/pipelines/${id}`),
  run: (id: number) =>
    api.post<RunSummary>(`/etl/pipelines/${id}/run`).then(r => r.data),
  getRuns: (id: number) =>
    api.get<RunSummary[]>(`/etl/pipelines/${id}/runs`).then(r => r.data),
  getGraph: () =>
    api
      .get<{ nodes: GraphNode[]; edges: GraphEdge[] }>('/etl/graph')
      .then(r => r.data),
}

// ── Runs API ──────────────────────────────────────────────────────────────────

export const runsApi = {
  list: () => api.get<RunSummary[]>('/etl/runs').then(r => r.data),
  get: (id: number) => api.get<RunDetail>(`/etl/runs/${id}`).then(r => r.data),
  cancel: (id: number) => api.post(`/etl/runs/${id}/cancel`),
  retrySparkLoad: (id: number) => api.post(`/etl/runs/${id}/retry-spark-load`).then(r => r.data),
  delete: (id: number) => api.delete(`/etl/runs/${id}`),
  clearAll: (pipelineId?: number) =>
    api.delete<{ deleted: number }>('/etl/runs', { params: pipelineId != null ? { pipeline_id: pipelineId } : {} }).then(r => r.data),
}

// ── Transform API ─────────────────────────────────────────────────────────────

export const transformApi = {
  listChains: () =>
    api.get<ETLChain[]>('/transform/chains').then(r => r.data),
  createChain: (data: Partial<ETLChain>) =>
    api.post<ETLChain>('/transform/chains', data).then(r => r.data),
  updateChain: (id: number, data: Partial<ETLChain>) =>
    api.put<ETLChain>(`/transform/chains/${id}`, data).then(r => r.data),
  deleteChain: (id: number) => api.delete(`/transform/chains/${id}`),
  runChain: (id: number) =>
    api.post<RunSummary>(`/transform/chains/${id}/run`).then(r => r.data),

  listJobs: () =>
    api.get<TransformJob[]>('/transform/jobs').then(r => r.data),
  createJob: (data: Partial<TransformJob>) =>
    api.post<TransformJob>('/transform/jobs', data).then(r => r.data),
  updateJob: (id: number, data: Partial<TransformJob>) =>
    api.put<TransformJob>(`/transform/jobs/${id}`, data).then(r => r.data),
  deleteJob: (id: number) => api.delete(`/transform/jobs/${id}`),
  runJob: (id: number) =>
    api.post<RunSummary>(`/transform/jobs/${id}/run`).then(r => r.data),

  listNotebooks: () =>
    api.get<NotebookFile[]>('/transform/notebooks').then(r => r.data),
  createNotebook: (data: Partial<NotebookFile>) =>
    api.post<NotebookFile>('/transform/notebooks', data).then(r => r.data),
  updateNotebook: (id: number, data: Partial<NotebookFile>) =>
    api.put<NotebookFile>(`/transform/notebooks/${id}`, data).then(r => r.data),
  deleteNotebook: (id: number) =>
    api.delete(`/transform/notebooks/${id}`),
  executeNotebook: (id: number, cells: NotebookCell[], reset = false) =>
    api.post<{ outputs: CellOutput[] }>(`/transform/notebooks/${id}/execute`, { cells, reset_session: reset }).then(r => r.data),
  exportNotebook: (id: number, config: ExportConfig) =>
    api.post<ExportResult>(`/transform/notebooks/${id}/export`, config).then(r => r.data),
}

// ── Data API ──────────────────────────────────────────────────────────────────

export interface BrowserDir {
  name: string
  path: string
  file_count: number
  format: string
  size_bytes: number
  last_modified: number
}

export interface PreviewResult {
  columns: string[]
  rows: unknown[][]
  row_count: number
  resolved_sql: string
}

export interface ExtractResult {
  total_rows: number
  file_count: number
  output_dir: string
  files: string[]
}

export const dataApi = {
  listTables: () => api.get<DataTable[]>('/data/tables').then(r => r.data),
  previewTable: (name: string, limit = 200, offset = 0) =>
    api.get<QueryResult>(`/data/tables/${encodeURIComponent(name)}/preview`, { params: { limit, offset } }).then(r => r.data),
  query: (sql: string, limit = 200, offset = 0, database?: string) =>
    api.post<QueryResult>('/data/query', { sql, limit, offset, database }).then(r => r.data),
  listBrowser: () => api.get<BrowserDir[]>('/data/browser').then(r => r.data),
  listCatalogTables: () => api.get<CatalogTable[]>('/data/catalog/tables').then(r => r.data),
  listDatabases: () => api.get<string[]>('/data/catalog/databases').then(r => r.data),
  sparkReconnect: () => api.post<{ status: string }>('/data/catalog/reconnect').then(r => r.data),
  sparkDisconnect: () => api.post<{ status: string }>('/data/catalog/disconnect').then(r => r.data),
  dropTempView: (viewName: string) => api.delete<{ status: string }>(`/data/catalog/views/${encodeURIComponent(viewName)}`).then(r => r.data),
  dropAllTempViews: () => api.delete<{ status: string; count: number }>('/data/catalog/views').then(r => r.data),
}

// ── Services API ──────────────────────────────────────────────────────────────

export const servicesApi = {
  status: () =>
    api.get<ServicesStatus>('/services/status').then(r => r.data),
  runSparkTest: () =>
    api.post<SparkTestResult>('/services/spark/run-test').then(r => r.data),
  testSparkConnection: () =>
    api.post<{ connected: boolean; message?: string; latency_ms?: number }>('/services/spark/test-connection').then(r => r.data),
}

// ── Context API ───────────────────────────────────────────────────────────────

export const contextApi = {
  get: () =>
    api.get<ExecutionContext>('/etl/context').then(r => r.data),
  update: (data: Partial<ExecutionContext>) =>
    api.put<ExecutionContext>('/etl/context', data).then(r => r.data),
}

// ── Dictionaries API ──────────────────────────────────────────────────────────

export const dictionariesApi = {
  list: () => api.get<Dictionary[]>('/dictionaries').then(r => r.data),
  create: (data: Partial<Dictionary>) =>
    api.post<Dictionary>('/dictionaries', data).then(r => r.data),
  update: (id: number, data: Partial<Dictionary>) =>
    api.put<Dictionary>(`/dictionaries/${id}`, data).then(r => r.data),
  delete: (id: number) => api.delete(`/dictionaries/${id}`),
  addEntry: (dictId: number, data: { key: string; value: string }) =>
    api.post<DictionaryEntry>(`/dictionaries/${dictId}/entries`, data).then(r => r.data),
  updateEntry: (dictId: number, entryId: number, data: { key?: string; value?: string }) =>
    api.put<DictionaryEntry>(`/dictionaries/${dictId}/entries/${entryId}`, data).then(r => r.data),
  deleteEntry: (dictId: number, entryId: number) =>
    api.delete(`/dictionaries/${dictId}/entries/${entryId}`),
}

// ── SQL Files API ─────────────────────────────────────────────────────────────

export const sqlFilesApi = {
  list: (file_type?: string) =>
    api.get<SqlFile[]>('/etl/sql-files', { params: file_type ? { file_type } : undefined }).then(r => r.data),
  create: (data: Partial<SqlFile>) =>
    api.post<SqlFile>('/etl/sql-files', data).then(r => r.data),
  update: (id: number, data: Partial<SqlFile>) =>
    api.put<SqlFile>(`/etl/sql-files/${id}`, data).then(r => r.data),
}

// ── Connections API ───────────────────────────────────────────────────────────

export const connectionsApi = {
  list: () => api.get<Connection[]>('/connections').then(r => r.data),
  create: (data: Partial<Connection> & { password?: string }) =>
    api.post<Connection>('/connections', data).then(r => r.data),
  update: (id: number, data: Partial<Connection> & { password?: string }) =>
    api.put<Connection>(`/connections/${id}`, data).then(r => r.data),
  delete: (id: number) => api.delete(`/connections/${id}`),
  test: (id: number) =>
    api.post<{ ok: boolean; latency_ms: number; message: string }>(`/connections/${id}/test`).then(r => r.data),
  testAdhoc: (params: {
    conn_type: string; host?: string; port?: number; database?: string;
    username?: string; password?: string; extra?: Record<string, unknown>;
  }) =>
    api.post<{ ok: boolean; latency_ms: number; message: string }>('/connections/test-adhoc', params).then(r => r.data),
  previewSql: (id: number, sql: string, params: Record<string, string>, limit = 100) =>
    api.post<PreviewResult>(`/connections/${id}/preview-sql`, { sql, params, limit })
      .then(r => r.data)
      .catch(err => { throw new Error(err.response?.data?.detail ?? err.message) }),
  extract: (id: number, sql: string, params: Record<string, string>, chunk_size = 50_000, output_subdir?: string) =>
    api.post<ExtractResult>(`/connections/${id}/extract`, { sql, params, chunk_size, output_subdir }).then(r => r.data),
  foreachExtract: (id: number, body: {
    sql: string
    dictionary_id: number
    key_param: string
    value_param: string
    static_params: Record<string, string>
    output_path_template: string
    chunk_size: number
    selected_keys?: string[]
  }) => api.post<ForeachEntryResult[]>(`/connections/${id}/foreach-extract`, body).then(r => r.data),
  /** Test a datawarehouse-type connection using the bespoke library. */
  testDW: (id: number) =>
    api.post<{ ok: boolean; latency_ms: number; message: string }>(`/connections/${id}/test-dw`).then(r => r.data),
  /** Stream a datawarehouse extract as SSE. Returns the raw fetch Response so the caller can read body as a stream. */
  extractDWUrl: (id: number) => `${api.defaults.baseURL}/connections/${id}/extract-dw`,
  /** Test an S3-type connection by checking bucket accessibility. */
  testS3: (id: number) =>
    api.post<{ ok: boolean; latency_ms: number; message: string }>(`/connections/${id}/test-s3`).then(r => r.data),
  /** List S3 files matching a prefix + pattern. */
  s3List: (id: number, body: { prefix?: string; pattern?: string; max_keys?: number }) =>
    api.post<{ count: number; keys: string[] }>(`/connections/${id}/s3-list`, body).then(r => r.data),
  /** Returns the S3 ingest SSE URL for streaming with fetch(). */
  s3IngestUrl: (id: number) => `${api.defaults.baseURL}/connections/${id}/s3-ingest`,
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata Catalogue
// ─────────────────────────────────────────────────────────────────────────────

export const COLUMN_TYPES = [
  'string', 'integer', 'long', 'float', 'double',
  'decimal', 'date', 'datetime', 'boolean', 'binary',
] as const
export type ColumnType = typeof COLUMN_TYPES[number]

export interface CatalogueColumn {
  id: number
  catalogue_id: number
  name: string
  data_type: ColumnType
  nullable: boolean
  description?: string
  position: number
  created_at: string
}

export interface Catalogue {
  id: number
  name: string
  description?: string
  created_at: string
  updated_at: string
  columns: CatalogueColumn[]
}

export const cataloguesApi = {
  list: () => api.get<Catalogue[]>('/catalogues').then(r => r.data),
  get: (id: number) => api.get<Catalogue>(`/catalogues/${id}`).then(r => r.data),
  create: (data: { name: string; description?: string }) =>
    api.post<Catalogue>('/catalogues', data).then(r => r.data),
  update: (id: number, data: { name?: string; description?: string }) =>
    api.put<Catalogue>(`/catalogues/${id}`, data).then(r => r.data),
  delete: (id: number) => api.delete(`/catalogues/${id}`),
  addColumn: (catId: number, col: { name: string; data_type: string; nullable?: boolean; description?: string; position?: number }) =>
    api.post<CatalogueColumn>(`/catalogues/${catId}/columns`, col).then(r => r.data),
  updateColumn: (catId: number, colId: number, col: Partial<{ name: string; data_type: string; nullable: boolean; description: string; position: number }>) =>
    api.put<CatalogueColumn>(`/catalogues/${catId}/columns/${colId}`, col).then(r => r.data),
  deleteColumn: (catId: number, colId: number) =>
    api.delete(`/catalogues/${catId}/columns/${colId}`),
  reorderColumns: (catId: number, columnIds: number[]) =>
    api.post<Catalogue>(`/catalogues/${catId}/columns/reorder`, columnIds).then(r => r.data),
}
