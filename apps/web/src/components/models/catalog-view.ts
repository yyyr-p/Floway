import type { ControlPlaneModel } from '../../api/types';

export const CATALOG_PAGE_SIZE = 50;

export const filterCatalogModels = (
  models: readonly ControlPlaneModel[],
  query: string,
): ControlPlaneModel[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...models];
  return models.filter(model => model.id.toLowerCase().includes(normalized)
    || model.display_name.toLowerCase().includes(normalized));
};

export const paginateCatalogModels = <Model>(
  models: readonly Model[],
  requestedPage: number,
  pageSize = CATALOG_PAGE_SIZE,
): { items: Model[]; page: number; pageCount: number } => {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError('Catalog page size must be a positive integer.');
  const pageCount = Math.max(1, Math.ceil(models.length / pageSize));
  const page = Number.isFinite(requestedPage)
    ? Math.min(pageCount, Math.max(1, Math.floor(requestedPage)))
    : 1;
  const start = (page - 1) * pageSize;
  return { items: models.slice(start, start + pageSize), page, pageCount };
};
