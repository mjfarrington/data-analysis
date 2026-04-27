"""
API integration tests for ETL pipeline and execution-context endpoints.

Tests use an isolated in-memory SQLite database (via the ``client`` fixture
from conftest.py) and do not require Spark.

Covers:
  * POST   /api/v1/etl/pipelines          — create pipeline
  * GET    /api/v1/etl/pipelines           — list
  * PUT    /api/v1/etl/pipelines/{id}      — update
  * DELETE /api/v1/etl/pipelines/{id}      — delete (cascades runs)
  * GET    /api/v1/etl/context             — get execution context (default)
  * PUT    /api/v1/etl/context             — update execution context
  * GET    /api/v1/etl/graph               — pipeline DAG
"""
from __future__ import annotations

import pytest

BASE = "/api/v1/etl"


# ─── Helper factories ─────────────────────────────────────────────────────────

def _pipeline_payload(name: str = "Test Pipeline", source_type: str = "jdbc") -> dict:
    return {
        "name": name,
        "description": "Automated test pipeline",
        "extract_config": {"source_type": source_type},
        "transform_config": {},
        "load_config": {"target": "parquet"},
    }


# ─── Pipeline CRUD ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_pipeline(client):
    r = await client.post(f"{BASE}/pipelines", json=_pipeline_payload("Create Test"))
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == "Create Test"
    assert data["status"] == "active"
    assert data["total_runs"] == 0
    assert "id" in data

    await client.delete(f"{BASE}/pipelines/{data['id']}")


@pytest.mark.asyncio
async def test_create_pipeline_with_jdbc_source(client):
    payload = _pipeline_payload("JDBC Pipeline", "jdbc")
    payload["extract_config"].update({
        "jdbc_url": "jdbc:postgresql://localhost/mydb",
        "jdbc_table": "customers",
    })
    r = await client.post(f"{BASE}/pipelines", json=payload)
    assert r.status_code == 201
    assert r.json()["extract_config"]["source_type"] == "jdbc"

    await client.delete(f"{BASE}/pipelines/{r.json()['id']}")


@pytest.mark.asyncio
async def test_list_pipelines_empty(client):
    r = await client.get(f"{BASE}/pipelines")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


@pytest.mark.asyncio
async def test_list_pipelines_returns_created(client):
    r = await client.post(f"{BASE}/pipelines", json=_pipeline_payload("List Test P"))
    pid = r.json()["id"]

    rl = await client.get(f"{BASE}/pipelines")
    assert rl.status_code == 200
    ids = [p["id"] for p in rl.json()]
    assert pid in ids

    await client.delete(f"{BASE}/pipelines/{pid}")


@pytest.mark.asyncio
async def test_update_pipeline_name(client):
    r = await client.post(f"{BASE}/pipelines", json=_pipeline_payload("Old Name"))
    pid = r.json()["id"]

    ru = await client.put(f"{BASE}/pipelines/{pid}", json={"name": "New Name"})
    assert ru.status_code == 200
    assert ru.json()["name"] == "New Name"

    await client.delete(f"{BASE}/pipelines/{pid}")


@pytest.mark.asyncio
async def test_update_pipeline_status_to_inactive(client):
    r = await client.post(f"{BASE}/pipelines", json=_pipeline_payload("Status Change"))
    pid = r.json()["id"]

    ru = await client.put(f"{BASE}/pipelines/{pid}", json={"status": "inactive"})
    assert ru.status_code == 200
    assert ru.json()["status"] == "inactive"

    await client.delete(f"{BASE}/pipelines/{pid}")


@pytest.mark.asyncio
async def test_update_nonexistent_pipeline_returns_404(client):
    r = await client.put(f"{BASE}/pipelines/999999", json={"name": "x"})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_pipeline(client):
    r = await client.post(f"{BASE}/pipelines", json=_pipeline_payload("Delete Me"))
    pid = r.json()["id"]

    rd = await client.delete(f"{BASE}/pipelines/{pid}")
    assert rd.status_code == 204


@pytest.mark.asyncio
async def test_delete_nonexistent_pipeline_returns_404(client):
    r = await client.delete(f"{BASE}/pipelines/999999")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_create_duplicate_pipeline_name_returns_error(client):
    """Duplicate pipeline name triggers DB UNIQUE constraint — any server-side
    error (exception or 5xx) is the expected outcome."""
    r1 = await client.post(f"{BASE}/pipelines", json=_pipeline_payload("Dup Name"))
    assert r1.status_code == 201
    with pytest.raises(Exception):
        await client.post(f"{BASE}/pipelines", json=_pipeline_payload("Dup Name"))

    await client.delete(f"{BASE}/pipelines/{r1.json()['id']}")


# ─── Execution context ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_context_creates_default(client):
    r = await client.get(f"{BASE}/context")
    assert r.status_code == 200
    data = r.json()
    assert data["id"] == 1
    assert data["business_date"] is None
    assert data["namespace_prefix"] == ""


@pytest.mark.asyncio
async def test_update_context_business_date(client):
    r = await client.put(f"{BASE}/context", json={"business_date": "2026-04-16"})
    assert r.status_code == 200
    assert r.json()["business_date"] == "2026-04-16"


@pytest.mark.asyncio
async def test_update_context_namespace_prefix(client):
    r = await client.put(f"{BASE}/context", json={"namespace_prefix": "markets_"})
    assert r.status_code == 200
    assert r.json()["namespace_prefix"] == "markets_"


@pytest.mark.asyncio
async def test_context_namespace_derived_correctly(client):
    """Derived namespace = prefix + date (compact YYYYMMDD)."""
    await client.put(f"{BASE}/context", json={
        "business_date": "2026-04-16",
        "namespace_prefix": "markets_",
    })
    r = await client.get(f"{BASE}/context")
    assert r.status_code == 200
    assert r.json()["namespace"] == "markets_20260416"


@pytest.mark.asyncio
async def test_context_namespace_without_prefix_is_date(client):
    await client.put(f"{BASE}/context", json={
        "business_date": "2026-04-16",
        "namespace_prefix": "",
    })
    r = await client.get(f"{BASE}/context")
    assert r.json()["namespace"] == "20260416"


@pytest.mark.asyncio
async def test_context_namespace_none_when_no_date(client):
    await client.put(f"{BASE}/context", json={"business_date": None})
    r = await client.get(f"{BASE}/context")
    assert r.json()["namespace"] is None


@pytest.mark.asyncio
async def test_context_clear_business_date(client):
    await client.put(f"{BASE}/context", json={"business_date": "2026-04-16"})
    await client.put(f"{BASE}/context", json={"business_date": ""})
    r = await client.get(f"{BASE}/context")
    assert r.json()["business_date"] is None


@pytest.mark.asyncio
async def test_get_context_is_idempotent(client):
    r1 = await client.get(f"{BASE}/context")
    r2 = await client.get(f"{BASE}/context")
    assert r1.json()["id"] == r2.json()["id"]


# ─── Pipeline graph ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_graph_empty_when_no_pipelines(client):
    r = await client.get(f"{BASE}/graph")
    assert r.status_code == 200
    data = r.json()
    assert "nodes" in data
    assert "edges" in data


@pytest.mark.asyncio
async def test_graph_contains_created_pipelines(client):
    ra = await client.post(f"{BASE}/pipelines", json=_pipeline_payload("Graph Node A"))
    rb = await client.post(f"{BASE}/pipelines", json=_pipeline_payload("Graph Node B"))
    pid_a, pid_b = ra.json()["id"], rb.json()["id"]

    r = await client.get(f"{BASE}/graph")
    assert r.status_code == 200
    data = r.json()

    node_ids = {n["id"] for n in data["nodes"]}
    assert pid_a in node_ids
    assert pid_b in node_ids

    await client.delete(f"{BASE}/pipelines/{pid_a}")
    await client.delete(f"{BASE}/pipelines/{pid_b}")


# ─── Trigger run — validation only (no real execution) ───────────────────────

@pytest.mark.asyncio
async def test_trigger_run_on_inactive_pipeline_returns_400(client):
    r = await client.post(f"{BASE}/pipelines", json=_pipeline_payload("Inactive P"))
    pid = r.json()["id"]

    await client.put(f"{BASE}/pipelines/{pid}", json={"status": "inactive"})
    rt = await client.post(f"{BASE}/pipelines/{pid}/run", json={})
    assert rt.status_code == 400

    await client.delete(f"{BASE}/pipelines/{pid}")


@pytest.mark.asyncio
async def test_trigger_run_on_nonexistent_pipeline_returns_404(client):
    r = await client.post(f"{BASE}/pipelines/999999/run", json={})
    assert r.status_code == 404
