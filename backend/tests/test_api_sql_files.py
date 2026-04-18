"""
API integration tests for the SQL File endpoints.

Tests use an isolated in-memory SQLite database (via the ``client`` fixture
from conftest.py) and do not require Spark.

Covers:
  * POST   /api/v1/etl/sql-files         — create (extract & transform types)
  * GET    /api/v1/etl/sql-files          — list (all / filtered by type)
  * PUT    /api/v1/etl/sql-files/{id}     — update content / metadata
"""
from __future__ import annotations

import pytest

BASE = "/api/v1/etl"

# ─── Helper factories ─────────────────────────────────────────────────────────

def _sql_payload(suffix: str = "test", file_type: str = "extract") -> dict:
    return {
        "name": f"sql_{file_type}_{suffix}",
        "description": f"Test {file_type} SQL",
        "file_type": file_type,
        "content": f"SELECT * FROM orders_{suffix}",
    }


# ─── Create ───────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_extract_sql_file(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("a", "extract"))
    assert r.status_code == 201
    data = r.json()
    assert data["file_type"] == "extract"
    assert data["name"] == "sql_extract_a"
    assert data["versions"] == []
    assert "id" in data


@pytest.mark.asyncio
async def test_create_transform_sql_file(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("b", "transform"))
    assert r.status_code == 201
    data = r.json()
    assert data["file_type"] == "transform"


@pytest.mark.asyncio
async def test_create_duplicate_name_returns_error(client):
    """The DB UNIQUE constraint on sql_files.name causes a server-side error."""
    r1 = await client.post(f"{BASE}/sql-files", json=_sql_payload("dup"))
    assert r1.status_code == 201
    with pytest.raises(Exception):
        await client.post(f"{BASE}/sql-files", json=_sql_payload("dup"))


# ─── List ─────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_list_sql_files_returns_created_files(client):
    r1 = await client.post(f"{BASE}/sql-files", json=_sql_payload("list1", "extract"))
    r2 = await client.post(f"{BASE}/sql-files", json=_sql_payload("list2", "transform"))
    ids = {r1.json()["id"], r2.json()["id"]}

    r = await client.get(f"{BASE}/sql-files")
    assert r.status_code == 200
    returned_ids = {f["id"] for f in r.json()}
    assert ids.issubset(returned_ids)


@pytest.mark.asyncio
async def test_list_sql_files_filtered_by_extract_type(client):
    await client.post(f"{BASE}/sql-files", json=_sql_payload("filt_ext", "extract"))
    await client.post(f"{BASE}/sql-files", json=_sql_payload("filt_trn", "transform"))

    r = await client.get(f"{BASE}/sql-files", params={"file_type": "extract"})
    assert r.status_code == 200
    types = {f["file_type"] for f in r.json()}
    assert "transform" not in types
    assert "extract" in types


@pytest.mark.asyncio
async def test_list_sql_files_filtered_by_transform_type(client):
    await client.post(f"{BASE}/sql-files", json=_sql_payload("filt2_ext", "extract"))
    await client.post(f"{BASE}/sql-files", json=_sql_payload("filt2_trn", "transform"))

    r = await client.get(f"{BASE}/sql-files", params={"file_type": "transform"})
    assert r.status_code == 200
    types = {f["file_type"] for f in r.json()}
    assert "extract" not in types


# ─── Update ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_update_sql_file_content(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("upd_content"))
    fid = r.json()["id"]

    r2 = await client.put(
        f"{BASE}/sql-files/{fid}",
        json={"content": "SELECT id, name FROM customers"},
    )
    assert r2.status_code == 200
    assert r2.json()["content"] == "SELECT id, name FROM customers"


@pytest.mark.asyncio
async def test_update_sql_file_description(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("upd_desc"))
    fid = r.json()["id"]

    r2 = await client.put(f"{BASE}/sql-files/{fid}", json={"description": "Updated desc"})
    assert r2.status_code == 200
    assert r2.json()["description"] == "Updated desc"


@pytest.mark.asyncio
async def test_update_nonexistent_sql_file_returns_404(client):
    r = await client.put(f"{BASE}/sql-files/999999", json={"content": "x"})
    assert r.status_code == 404
