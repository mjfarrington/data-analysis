"""
Dictionaries API — CRUD for named key/value lookup tables.
Example: map Application Name → Application ID for use in ETL queries.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.models.etl import Dictionary, DictionaryEntry
from app.schemas.etl import (
    DictionaryCreate, DictionaryUpdate, DictionaryOut,
    DictionaryEntryCreate, DictionaryEntryUpdate, DictionaryEntryOut,
)

router = APIRouter(prefix="/dictionaries", tags=["Dictionaries"])


def _normalize_extra_columns(columns: list[str] | None) -> list[str]:
    if not columns:
        return []
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in columns:
        name = str(raw).strip()
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(name)
    return cleaned


def _normalize_entry_extra(extra: dict | None, allowed_columns: list[str]) -> dict[str, str]:
    if not extra:
        return {}
    allowed = {col.casefold(): col for col in allowed_columns}
    normalized: dict[str, str] = {}
    for raw_key, raw_value in extra.items():
        key = str(raw_key).strip()
        if not key:
            continue
        canonical = allowed.get(key.casefold())
        if not canonical:
            continue
        normalized[canonical] = "" if raw_value is None else str(raw_value)
    return normalized


@router.get("", response_model=list[DictionaryOut])
async def list_dictionaries(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Dictionary)
        .options(selectinload(Dictionary.entries))
        .order_by(Dictionary.name)
    )
    return result.scalars().all()


@router.post("", response_model=DictionaryOut, status_code=201)
async def create_dictionary(data: DictionaryCreate, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(select(Dictionary).where(Dictionary.name == data.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Dictionary '{data.name}' already exists")
    payload = data.model_dump()
    payload["extra_columns"] = _normalize_extra_columns(payload.get("extra_columns"))
    d = Dictionary(**payload)
    db.add(d)
    await db.commit()
    await db.refresh(d)
    result = await db.execute(
        select(Dictionary).where(Dictionary.id == d.id).options(selectinload(Dictionary.entries))
    )
    return result.scalar_one()


@router.put("/{dict_id}", response_model=DictionaryOut)
async def update_dictionary(dict_id: int, data: DictionaryUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Dictionary).where(Dictionary.id == dict_id).options(selectinload(Dictionary.entries))
    )
    d = result.scalar_one_or_none()
    if not d:
        raise HTTPException(status_code=404, detail="Dictionary not found")
    payload = data.model_dump(exclude_none=True)
    if "extra_columns" in payload:
        payload["extra_columns"] = _normalize_extra_columns(payload.get("extra_columns"))
    for field, val in payload.items():
        setattr(d, field, val)
    await db.commit()
    await db.refresh(d)
    result = await db.execute(
        select(Dictionary).where(Dictionary.id == dict_id).options(selectinload(Dictionary.entries))
    )
    return result.scalar_one()


@router.delete("/{dict_id}", status_code=204)
async def delete_dictionary(dict_id: int, db: AsyncSession = Depends(get_db)):
    d = await db.get(Dictionary, dict_id)
    if not d:
        raise HTTPException(status_code=404, detail="Dictionary not found")
    await db.delete(d)
    await db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Entry sub-resource
# ─────────────────────────────────────────────────────────────────────────────

async def _get_dict(dict_id: int, db: AsyncSession) -> Dictionary:
    d = await db.get(Dictionary, dict_id)
    if not d:
        raise HTTPException(status_code=404, detail="Dictionary not found")
    return d


@router.post("/{dict_id}/entries", response_model=DictionaryEntryOut, status_code=201)
async def add_entry(dict_id: int, data: DictionaryEntryCreate, db: AsyncSession = Depends(get_db)):
    d = await _get_dict(dict_id, db)
    payload = data.model_dump()
    payload["extra"] = _normalize_entry_extra(payload.get("extra"), d.extra_columns or [])
    entry = DictionaryEntry(dictionary_id=dict_id, **payload)
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return entry


@router.put("/{dict_id}/entries/{entry_id}", response_model=DictionaryEntryOut)
async def update_entry(dict_id: int, entry_id: int, data: DictionaryEntryUpdate, db: AsyncSession = Depends(get_db)):
    d = await _get_dict(dict_id, db)
    entry = await db.get(DictionaryEntry, entry_id)
    if not entry or entry.dictionary_id != dict_id:
        raise HTTPException(status_code=404, detail="Entry not found")
    payload = data.model_dump(exclude_none=True)
    if "extra" in payload:
        payload["extra"] = _normalize_entry_extra(payload.get("extra"), d.extra_columns or [])
    for field, val in payload.items():
        setattr(entry, field, val)
    await db.commit()
    await db.refresh(entry)
    return entry


@router.delete("/{dict_id}/entries/{entry_id}", status_code=204)
async def delete_entry(dict_id: int, entry_id: int, db: AsyncSession = Depends(get_db)):
    await _get_dict(dict_id, db)
    entry = await db.get(DictionaryEntry, entry_id)
    if not entry or entry.dictionary_id != dict_id:
        raise HTTPException(status_code=404, detail="Entry not found")
    await db.delete(entry)
    await db.commit()
