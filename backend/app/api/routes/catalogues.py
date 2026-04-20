"""
Catalogues API — CRUD for metadata schema definitions (typed column lists).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.models.etl import Catalogue, CatalogueColumn
from app.schemas.etl import (
    CatalogueCreate, CatalogueUpdate, CatalogueOut,
    CatalogueColumnCreate, CatalogueColumnUpdate, CatalogueColumnOut,
    COLUMN_TYPES,
)

router = APIRouter(prefix="/catalogues", tags=["Catalogues"])


def _with_columns(q):
    return q.options(selectinload(Catalogue.columns))


@router.get("", response_model=list[CatalogueOut])
async def list_catalogues(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Catalogue).options(selectinload(Catalogue.columns)).order_by(Catalogue.name)
    )
    return result.scalars().all()


@router.post("", response_model=CatalogueOut, status_code=201)
async def create_catalogue(data: CatalogueCreate, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(select(Catalogue).where(Catalogue.name == data.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Catalogue '{data.name}' already exists")
    cat = Catalogue(**data.model_dump())
    db.add(cat)
    await db.commit()
    await db.refresh(cat)
    result = await db.execute(
        select(Catalogue).where(Catalogue.id == cat.id).options(selectinload(Catalogue.columns))
    )
    return result.scalar_one()


@router.get("/{cat_id}", response_model=CatalogueOut)
async def get_catalogue(cat_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Catalogue).where(Catalogue.id == cat_id).options(selectinload(Catalogue.columns))
    )
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(status_code=404, detail="Catalogue not found")
    return cat


@router.put("/{cat_id}", response_model=CatalogueOut)
async def update_catalogue(cat_id: int, data: CatalogueUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Catalogue).where(Catalogue.id == cat_id).options(selectinload(Catalogue.columns))
    )
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(status_code=404, detail="Catalogue not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(cat, field, value)
    await db.commit()
    await db.refresh(cat)
    result = await db.execute(
        select(Catalogue).where(Catalogue.id == cat_id).options(selectinload(Catalogue.columns))
    )
    return result.scalar_one()


@router.delete("/{cat_id}", status_code=204)
async def delete_catalogue(cat_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Catalogue).where(Catalogue.id == cat_id))
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(status_code=404, detail="Catalogue not found")
    await db.delete(cat)
    await db.commit()


# ── Columns ──────────────────────────────────────────────────────────────────

@router.post("/{cat_id}/columns", response_model=CatalogueColumnOut, status_code=201)
async def add_column(cat_id: int, data: CatalogueColumnCreate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Catalogue).where(Catalogue.id == cat_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Catalogue not found")
    if data.data_type not in COLUMN_TYPES:
        raise HTTPException(status_code=422, detail=f"Unknown type '{data.data_type}'. Must be one of: {COLUMN_TYPES}")
    col = CatalogueColumn(catalogue_id=cat_id, **data.model_dump())
    db.add(col)
    await db.commit()
    await db.refresh(col)
    return col


@router.put("/{cat_id}/columns/{col_id}", response_model=CatalogueColumnOut)
async def update_column(
    cat_id: int, col_id: int, data: CatalogueColumnUpdate, db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(CatalogueColumn).where(
            CatalogueColumn.id == col_id, CatalogueColumn.catalogue_id == cat_id
        )
    )
    col = result.scalar_one_or_none()
    if not col:
        raise HTTPException(status_code=404, detail="Column not found")
    patch = data.model_dump(exclude_unset=True)
    if "data_type" in patch and patch["data_type"] not in COLUMN_TYPES:
        raise HTTPException(status_code=422, detail=f"Unknown type '{patch['data_type']}'. Must be one of: {COLUMN_TYPES}")
    for field, value in patch.items():
        setattr(col, field, value)
    await db.commit()
    await db.refresh(col)
    return col


@router.delete("/{cat_id}/columns/{col_id}", status_code=204)
async def delete_column(cat_id: int, col_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(CatalogueColumn).where(
            CatalogueColumn.id == col_id, CatalogueColumn.catalogue_id == cat_id
        )
    )
    col = result.scalar_one_or_none()
    if not col:
        raise HTTPException(status_code=404, detail="Column not found")
    await db.delete(col)
    await db.commit()


@router.post("/{cat_id}/columns/reorder", response_model=CatalogueOut)
async def reorder_columns(cat_id: int, column_ids: list[int], db: AsyncSession = Depends(get_db)):
    """Set position of each column by passing an ordered list of column IDs."""
    result = await db.execute(
        select(Catalogue).where(Catalogue.id == cat_id).options(selectinload(Catalogue.columns))
    )
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(status_code=404, detail="Catalogue not found")
    id_to_col = {c.id: c for c in cat.columns}
    for pos, col_id in enumerate(column_ids):
        if col_id in id_to_col:
            id_to_col[col_id].position = pos
    await db.commit()
    result = await db.execute(
        select(Catalogue).where(Catalogue.id == cat_id).options(selectinload(Catalogue.columns))
    )
    return result.scalar_one()
