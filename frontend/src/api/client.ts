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
  last_run?: RunSummary
}

export interface RunStep {
  id: number
  run_id: number
  step_order: number
  step_type: 'extract' | 'transform' | 'load'
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

export interface RunDetail extends RunSummary {
  pipeline_id: number
  logs: RunLog[]
  steps: RunStep[]
}

export interface ChainStep {
  order: number
  type: 'pipeline' | 'transform'
  pipeline_id?: number
  job_id?: number
  label: string
}

export interface ETLChain {
  id: number
  name: string
  description?: string
  status?: string
  steps: ChainStep[]
}

export interface TransformJob {
  id: number
  name: string
  description?: string
  job_type: string
  status: string
  source_table?: string
  target_table?: string
}

export interface NotebookCell {
  id: string
  type: 'code' | 'markdown'
  content: string
}

export interface NotebookFile {
  id: number
  name: string
  description?: string
  cells: NotebookCell[]
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
  entries: DictionaryEntry[]
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
}

export interface ExecutionContext {
  business_date: string
  namespace: string
  namespace_prefix?: string
}

// ── Pipelines API ─────────────────────────────────────────────────────────────

export const pipelinesApi = {
  list: () => api.get<Pipeline[]>('/etl/pipelines').then(r => r.data),
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
}

// ── Data API ──────────────────────────────────────────────────────────────────

export const dataApi = {
  listTables: () => api.get<DataTable[]>('/data/tables').then(r => r.data),
  previewTable: (name: string) =>
    api.get<QueryResult>(`/data/tables/${name}/preview`).then(r => r.data),
  query: (sql: string) =>
    api.post<QueryResult>('/data/query', { sql }).then(r => r.data),
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
}

// ── SQL Files API ─────────────────────────────────────────────────────────────

export const sqlFilesApi = {
  list: () => api.get<SqlFile[]>('/etl/sql-files').then(r => r.data),
  create: (data: Partial<SqlFile>) =>
    api.post<SqlFile>('/etl/sql-files', data).then(r => r.data),
  update: (id: number, data: Partial<SqlFile>) =>
    api.put<SqlFile>(`/etl/sql-files/${id}`, data).then(r => r.data),
}
