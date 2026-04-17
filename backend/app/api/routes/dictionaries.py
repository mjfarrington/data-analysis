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


# ─── Dictionaries ────────────────────────────────────────────────────────────

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
    d = Dictionary(**data.model_dump())
    db.add(d)
    await db.commit()
    await db.refresh(d)
    result = await db.execute(
        select(Dictionary).where(Dictionary.id == d.id).options(selectinload(Dictionary.entries))
    )
    return result.scalar_one()


@router.get("/{dict_id}", response_model=DictionaryOut)
async def get_dictionary(dict_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Dictionary).where(Dictionary.id == dict_id).options(selectinload(Dictionary.entries))
    )
    d = result.scalar_one_or_none()
    if not d:
        raise HTTPException(status_code=404, detail="Dictionary not found")
    return d


@router.put("/{dict_id}", response_model=DictionaryOut)
async def update_dictionary(dict_id: int, data: DictionaryUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Dictionary).where(Dictionary.id == dict_id).options(selectinload(Dictionary.entries))
    )
    d = result.scalar_one_or_none()
    if not d:
        raise HTTPException(status_code=404, detail="Dictionary not found")
    for field, val in data.model_dump(exclude_none=True).items():
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


# ─── Entries ─────────────────────────────────────────────────────────────────

@router.post("/{dict_id}/entries", response_model=DictionaryEntryOut, status_code=201)
async def create_entry(dict_id: int, data: DictionaryEntryCreate, db: AsyncSession = Depends(get_db)):
    d = await db.get(Dictionary, dict_id)
    if not d:
        raise HTTPException(status_code=404, detail="Dictionary not found")
    entry = DictionaryEntry(dictionary_id=dict_id, key=data.key, value=data.value)
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return entry


@router.put("/{dict_id}/entries/{entry_id}", response_model=DictionaryEntryOut)
async def update_entry(dict_id: int, entry_id: int, data: DictionaryEntryUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(DictionaryEntry).where(
            DictionaryEntry.id == entry_id,
            DictionaryEntry.dictionary_id == dict_id,
        )
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    for field, val in data.model_dump(exclude_none=True).items():
        setattr(entry, field, val)
    await db.commit()
    await db.refresh(entry)
    return entry


@router.delete("/{dict_id}/entries/{entry_id}", status_code=204)
async def delete_entry(dict_id: int, entry_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(DictionaryEntry).where(
            DictionaryEntry.id == entry_id,
            DictionaryEntry.dictionary_id == dict_id,
        )
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    await db.delete(entry)
    await db.commit()
