"""
API integration tests for the SQL File endpoints.

Tests use an isolated in-memory SQLite database (via the ``client`` fixture
from conftest.py) and do not require Spark.

Covers:
  * POST   /api/v1/etl/sql-files         — create (extract & transform types)
  * GET    /api/v1/etl/sql-files          — list (all / filtered by type)
  * GET    /api/v1/etl/sql-files/{id}     — retrieve single
  * PUT    /api/v1/etl/sql-files/{id}     — update content / metadata
  * DELETE /api/v1/etl/sql-files/{id}     — delete
  * GET    /api/v1/etl/sql-files/{id}/versions  — list versions (initially empty)
  * POST   /api/v1/etl/sql-files/{id}/versions  — snapshot (semver auto-increment)
  * PATCH  /api/v1/etl/sql-files/{id}/versions/{vid}/tag — retag
  * POST   /api/v1/etl/sql/preview        — SQL variable injection preview
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

    # cleanup
    await client.delete(f"{BASE}/sql-files/{data['id']}")


@pytest.mark.asyncio
async def test_create_transform_sql_file(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("b", "transform"))
    assert r.status_code == 201
    data = r.json()
    assert data["file_type"] == "transform"

    await client.delete(f"{BASE}/sql-files/{data['id']}")


@pytest.mark.asyncio
async def test_create_duplicate_name_returns_error(client):
    """The DB UNIQUE constraint on sql_files.name causes a server-side error.
    The route does not catch IntegrityError, so the exception propagates; any
    error response or exception is acceptable here — the important thing is
    that the first record was created and the second is rejected.
    """
    r1 = await client.post(f"{BASE}/sql-files", json=_sql_payload("dup"))
    assert r1.status_code == 201
    with pytest.raises(Exception):
        await client.post(f"{BASE}/sql-files", json=_sql_payload("dup"))

    await client.delete(f"{BASE}/sql-files/{r1.json()['id']}")


# ─── Read ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_sql_file_by_id(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("get_test"))
    fid = r.json()["id"]

    r2 = await client.get(f"{BASE}/sql-files/{fid}")
    assert r2.status_code == 200
    assert r2.json()["id"] == fid

    await client.delete(f"{BASE}/sql-files/{fid}")


@pytest.mark.asyncio
async def test_get_sql_file_not_found(client):
    r = await client.get(f"{BASE}/sql-files/999999")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_list_sql_files_returns_created_files(client):
    r1 = await client.post(f"{BASE}/sql-files", json=_sql_payload("list1", "extract"))
    r2 = await client.post(f"{BASE}/sql-files", json=_sql_payload("list2", "transform"))
    ids = {r1.json()["id"], r2.json()["id"]}

    r = await client.get(f"{BASE}/sql-files")
    assert r.status_code == 200
    returned_ids = {f["id"] for f in r.json()}
    assert ids.issubset(returned_ids)

    for fid in ids:
        await client.delete(f"{BASE}/sql-files/{fid}")


@pytest.mark.asyncio
async def test_list_sql_files_filtered_by_extract_type(client):
    r1 = await client.post(f"{BASE}/sql-files", json=_sql_payload("filt_ext", "extract"))
    r2 = await client.post(f"{BASE}/sql-files", json=_sql_payload("filt_trn", "transform"))

    r = await client.get(f"{BASE}/sql-files", params={"file_type": "extract"})
    assert r.status_code == 200
    types = {f["file_type"] for f in r.json()}
    assert "transform" not in types
    assert "extract" in types

    await client.delete(f"{BASE}/sql-files/{r1.json()['id']}")
    await client.delete(f"{BASE}/sql-files/{r2.json()['id']}")


@pytest.mark.asyncio
async def test_list_sql_files_filtered_by_transform_type(client):
    r1 = await client.post(f"{BASE}/sql-files", json=_sql_payload("filt2_ext", "extract"))
    r2 = await client.post(f"{BASE}/sql-files", json=_sql_payload("filt2_trn", "transform"))

    r = await client.get(f"{BASE}/sql-files", params={"file_type": "transform"})
    assert r.status_code == 200
    types = {f["file_type"] for f in r.json()}
    assert "extract" not in types

    await client.delete(f"{BASE}/sql-files/{r1.json()['id']}")
    await client.delete(f"{BASE}/sql-files/{r2.json()['id']}")


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

    await client.delete(f"{BASE}/sql-files/{fid}")


@pytest.mark.asyncio
async def test_update_sql_file_description(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("upd_desc"))
    fid = r.json()["id"]

    r2 = await client.put(f"{BASE}/sql-files/{fid}", json={"description": "Updated desc"})
    assert r2.status_code == 200
    assert r2.json()["description"] == "Updated desc"

    await client.delete(f"{BASE}/sql-files/{fid}")


@pytest.mark.asyncio
async def test_update_nonexistent_sql_file_returns_404(client):
    r = await client.put(f"{BASE}/sql-files/999999", json={"content": "x"})
    assert r.status_code == 404


# ─── Delete ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_delete_sql_file(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("del_me"))
    fid = r.json()["id"]

    r_del = await client.delete(f"{BASE}/sql-files/{fid}")
    assert r_del.status_code == 204

    r_get = await client.get(f"{BASE}/sql-files/{fid}")
    assert r_get.status_code == 404


@pytest.mark.asyncio
async def test_delete_nonexistent_sql_file_returns_404(client):
    r = await client.delete(f"{BASE}/sql-files/999999")
    assert r.status_code == 404


# ─── Versions ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_list_versions_initially_empty(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("ver_empty"))
    fid = r.json()["id"]

    rv = await client.get(f"{BASE}/sql-files/{fid}/versions")
    assert rv.status_code == 200
    assert rv.json() == []

    await client.delete(f"{BASE}/sql-files/{fid}")


@pytest.mark.asyncio
async def test_create_first_version_is_v010(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("ver_first"))
    fid = r.json()["id"]

    rv = await client.post(f"{BASE}/sql-files/{fid}/versions", json={"tag": "DRAFT"})
    assert rv.status_code == 201
    ver = rv.json()
    assert ver["version"] == "v0.1.0"
    assert ver["tag"] == "DRAFT"
    assert ver["content"] == r.json()["content"]  # snapshot of current content

    await client.delete(f"{BASE}/sql-files/{fid}")


@pytest.mark.asyncio
async def test_second_version_auto_increments(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("ver_incr"))
    fid = r.json()["id"]

    await client.post(f"{BASE}/sql-files/{fid}/versions", json={"tag": "DRAFT"})
    rv2 = await client.post(f"{BASE}/sql-files/{fid}/versions", json={"tag": "REVIEW"})
    assert rv2.status_code == 201
    assert rv2.json()["version"] == "v0.1.1"

    await client.delete(f"{BASE}/sql-files/{fid}")


@pytest.mark.asyncio
async def test_list_versions_after_creation(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("ver_list"))
    fid = r.json()["id"]

    await client.post(f"{BASE}/sql-files/{fid}/versions", json={"tag": "DRAFT"})
    await client.post(f"{BASE}/sql-files/{fid}/versions", json={"tag": "REVIEW"})

    rv = await client.get(f"{BASE}/sql-files/{fid}/versions")
    assert rv.status_code == 200
    assert len(rv.json()) == 2

    await client.delete(f"{BASE}/sql-files/{fid}")


@pytest.mark.asyncio
async def test_create_version_for_nonexistent_file_returns_404(client):
    rv = await client.post(f"{BASE}/sql-files/999999/versions", json={"tag": "DRAFT"})
    assert rv.status_code == 404


@pytest.mark.asyncio
async def test_retag_version(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("ver_retag"))
    fid = r.json()["id"]
    rv = await client.post(f"{BASE}/sql-files/{fid}/versions", json={"tag": "DRAFT"})
    vid = rv.json()["id"]

    rt = await client.patch(
        f"{BASE}/sql-files/{fid}/versions/{vid}/tag", json={"tag": "FINAL"}
    )
    assert rt.status_code == 200
    assert rt.json()["tag"] == "FINAL"

    await client.delete(f"{BASE}/sql-files/{fid}")


@pytest.mark.asyncio
async def test_retag_version_wrong_file_id_returns_404(client):
    r = await client.post(f"{BASE}/sql-files", json=_sql_payload("ver_retag_bad"))
    fid = r.json()["id"]
    rv = await client.post(f"{BASE}/sql-files/{fid}/versions", json={"tag": "DRAFT"})
    vid = rv.json()["id"]

    rt = await client.patch(
        f"{BASE}/sql-files/999999/versions/{vid}/tag", json={"tag": "FINAL"}
    )
    assert rt.status_code == 404

    await client.delete(f"{BASE}/sql-files/{fid}")


# ─── SQL preview (variable injection) ────────────────────────────────────────

@pytest.mark.asyncio
async def test_preview_inline_sql_no_context(client):
    """Without a platform business date, $business_date is not substituted."""
    r = await client.post(f"{BASE}/sql/preview", json={
        "sql": "SELECT $business_date AS d",
        "date_var_format": "YYYYMMDD",
        "date_range_mode": "single",
    })
    assert r.status_code == 200
    data = r.json()
    # No context set → business_date is None → SQL unchanged
    assert data["business_date"] is None
    assert data["resolved_sql"] == "SELECT $business_date AS d"
    assert data["variables"] == {}


@pytest.mark.asyncio
async def test_preview_after_setting_business_date(client):
    """With a platform business date set, placeholders are resolved."""
    # Set the platform business date
    await client.put(f"{BASE}/context", json={"business_date": "2026-04-16"})

    r = await client.post(f"{BASE}/sql/preview", json={
        "sql": "WHERE dt = $business_date",
        "date_var_format": "YYYYMMDD",
        "date_range_mode": "single",
    })
    assert r.status_code == 200
    data = r.json()
    assert data["business_date"] == "2026-04-16"
    assert "20260416" in data["resolved_sql"]
    assert "$business_date" in data["variables"]


@pytest.mark.asyncio
async def test_preview_current_month_range(client):
    await client.put(f"{BASE}/context", json={"business_date": "2026-04-16"})

    r = await client.post(f"{BASE}/sql/preview", json={
        "sql": "WHERE dt BETWEEN $business_date_from AND $business_date_to",
        "date_var_format": "YYYYMMDD",
        "date_range_mode": "current_month",
    })
    assert r.status_code == 200
    data = r.json()
    assert "20260401" in data["resolved_sql"]
    assert "20260430" in data["resolved_sql"]


@pytest.mark.asyncio
async def test_preview_via_sql_file_id(client):
    """preview endpoint can resolve via sql_file_id reference."""
    cr = await client.post(f"{BASE}/sql-files", json={
        "name": "preview_ref_file",
        "file_type": "extract",
        "content": "SELECT * FROM t WHERE d = $business_date",
    })
    fid = cr.json()["id"]

    await client.put(f"{BASE}/context", json={"business_date": "2026-04-16"})

    r = await client.post(f"{BASE}/sql/preview", json={
        "sql_file_id": fid,
        "date_var_format": "YYYYMMDD",
        "date_range_mode": "single",
    })
    assert r.status_code == 200
    assert "20260416" in r.json()["resolved_sql"]

    await client.delete(f"{BASE}/sql-files/{fid}")


@pytest.mark.asyncio
async def test_preview_missing_sql_and_file_id_returns_422(client):
    r = await client.post(f"{BASE}/sql/preview", json={
        "date_var_format": "YYYYMMDD",
    })
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_preview_nonexistent_sql_file_id_returns_404(client):
    r = await client.post(f"{BASE}/sql/preview", json={
        "sql_file_id": 999999,
        "date_var_format": "YYYYMMDD",
    })
    assert r.status_code == 404
