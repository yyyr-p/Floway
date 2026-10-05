import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { indexCatalog } from '../../../src/components/models/catalog-index';
import { CatalogMetadata } from '../../../src/components/models/catalog-metadata';
import { ModelCatalogTable } from '../../../src/components/models/catalog-table';
import { filterCatalogModels, paginateCatalogModels } from '../../../src/components/models/catalog-view';
import { i18n } from '../../../src/i18n';
import { catalogModel } from '../../api/model-fixture';
import { renderInApp } from '../../render';

const metadataValue = (field: string) =>
  screen.getByText(i18n.t(`dashboard.modelsCatalog.metadata.${field}`)).parentElement?.nextElementSibling;

describe('model catalog view', () => {
  it('searches the display name and model id without regard to case', () => {
    const models = [
      catalogModel('vendor/alpha', { display_name: 'Alpha Chat' }),
      catalogModel('beta', { display_name: 'Beta Chat' }),
    ];

    expect(filterCatalogModels(models, 'ALPHA')).toEqual([models[0]]);
    expect(filterCatalogModels(models, 'vendor/')).toEqual([models[0]]);
  });

  it('paginates large catalogs and clamps a page after filtering', () => {
    const models = Array.from({ length: 120 }, (_, index) => catalogModel(`model-${index}`));

    expect(paginateCatalogModels(models, 3, 50)).toMatchObject({ page: 3, pageCount: 3, items: models.slice(100) });
    expect(paginateCatalogModels(models.slice(0, 2), 3, 50)).toMatchObject({ page: 1, pageCount: 1, items: models.slice(0, 2) });
  });

  it('renders explicit false separately from unknown metadata', () => {
    renderInApp(<CatalogMetadata model={catalogModel('false-values', {
      chat: {
        image_detail_original: false,
        modalities: { input: [], output: ['text'] },
        reasoning: { adaptive: false, mandatory: false },
      },
    })} />);

    const unknown = i18n.t('dashboard.modelsCatalog.metadata.unknown');
    const no = i18n.t('dashboard.modelsCatalog.metadata.no');
    const none = i18n.t('dashboard.modelsCatalog.metadata.none');
    const imageValue = metadataValue('imageDetailOriginal');
    const adaptiveValue = metadataValue('adaptive');
    const inputValue = metadataValue('inputModalities');
    const mandatoryValue = metadataValue('mandatory');

    expect(imageValue?.textContent).toContain(no);
    expect(adaptiveValue?.textContent).toContain(no);
    expect(mandatoryValue?.textContent).toContain(no);
    expect(inputValue?.textContent).toContain(none);
    expect(metadataValue('outputModalities')?.textContent).toContain('text');
    expect(metadataValue('defaultEffort')?.textContent).toContain(unknown);
  });

  it('reports omitted metadata as unknown', () => {
    renderInApp(<CatalogMetadata model={catalogModel('unknown-model')} />);

    expect(metadataValue('imageDetailOriginal')?.textContent).toContain(i18n.t('dashboard.modelsCatalog.metadata.unknown'));
    expect(metadataValue('context')?.textContent).toContain(i18n.t('dashboard.modelsCatalog.metadata.unknown'));
  });

  it('filters the table and opens metadata from an accessible row action', () => {
    const models = [
      catalogModel('alpha-id', { display_name: 'Alpha Chat' }),
      catalogModel('beta-id', { display_name: 'Beta Chat' }),
    ];
    renderInApp(<ModelCatalogTable cap={null} catalog={indexCatalog(models)} models={models} />);

    fireEvent.change(screen.getByRole('textbox', { name: i18n.t('dashboard.modelsCatalog.search') }), {
      target: { value: 'alpha' },
    });
    expect(screen.getByText('Alpha Chat')).toBeTruthy();
    expect(screen.queryByText('Beta Chat')).toBeNull();

    const showDetails = screen.getByRole('button', {
      name: i18n.t('dashboard.modelsCatalog.showDetails', { model: 'Alpha Chat' }),
    });
    expect(showDetails.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(showDetails);
    expect(screen.getByRole('heading', { name: i18n.t('dashboard.modelsCatalog.metadata.heading') })).toBeTruthy();
    const hideDetails = screen.getByRole('button', {
      name: i18n.t('dashboard.modelsCatalog.hideDetails', { model: 'Alpha Chat' }),
    });
    expect(hideDetails.getAttribute('aria-expanded')).toBe('true');
  });

  it('mounts one page of rows and moves forward with a labeled control', () => {
    const models = Array.from({ length: 51 }, (_, index) => catalogModel(`model-${index}`, { display_name: `Model ${index}` }));
    renderInApp(<ModelCatalogTable cap={null} catalog={indexCatalog(models)} models={models} />);

    expect(screen.getByText('Model 49')).toBeTruthy();
    expect(screen.queryByText('Model 50')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.modelsCatalog.nextPage') }));
    expect(screen.getByText('Model 50')).toBeTruthy();
    expect(screen.getByText(i18n.t('dashboard.modelsCatalog.page', { current: 2, total: 2 }))).toBeTruthy();
  });
});
