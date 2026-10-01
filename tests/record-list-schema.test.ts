import { describe, expect, it } from 'vitest'
import {
  getProjectedAliases,
  moduleListQuerySchema,
} from '@/features/records/record-list.schema.js'
import { models } from '@/features/records/record-models.js'

describe('module list query validation', () => {
  it('applies bounded pagination defaults', () => {
    expect(moduleListQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 25,
      search: '',
      status: undefined,
      sort: undefined,
      order: 'asc',
    })
  })

  it('rejects invalid page sizes and unknown query fields', () => {
    expect(moduleListQuerySchema.safeParse({ limit: 500 }).success).toBe(false)
    expect(moduleListQuerySchema.safeParse({ unsupported: 'value' }).success).toBe(false)
  })

  it('extracts sortable output aliases from trusted module queries', () => {
    const aliases = getProjectedAliases(
      'select p.name as "Product", p.sku as "SKU" from products p',
    )

    expect([...aliases]).toEqual(['Product', 'SKU'])
  })

  it('keeps configured searchable fields in each module query projection', () => {
    for (const [moduleId, model] of Object.entries(models)) {
      const aliases = getProjectedAliases(model.query)
      expect(
        model.searchFields.every((field) => aliases.has(field)),
        moduleId,
      ).toBe(true)
    }
  })

  it('includes stable expense IDs for review actions', () => {
    expect(getProjectedAliases(models.expenses?.query ?? '').has('id')).toBe(true)
  })
})
